/**
 * TuiInputSurface — routes keyboard / pointer / wheel / paste / focus / IME
 * events to the PTY while an alt-screen (TUI) program is active.
 *
 * Design
 * ------
 * While `useAltScreenMode().active` is true, alt-screen programs (vim, htop,
 * less, tmux, fzf, ...) need to see every keystroke, every mouse event, and
 * every paste as PTY bytes. The Composer (a textarea that buffers input
 * client-side and only submits on Enter) is the wrong sink for that traffic:
 * - arrow keys navigate the textarea instead of the TUI,
 * - Ctrl+C never reaches the program,
 * - wheel scrolls the composer, not `less`.
 *
 * This component is the single alt-screen-active DOM sink. It:
 *   1. Renders an invisible, absolutely-positioned, focusable `<div>` that
 *      covers the terminal chrome.
 *   2. Auto-focuses on alt-screen enter.
 *   3. Mounts `features/input/input-host` against that div so every DOM event
 *      flows through KeyEncoder / MouseEncoder / Paste / Focus encoders and
 *      emerges as PTY bytes.
 *   4. Writes those bytes to the session via the session-tabs connection
 *      (whose `write()` honors the degraded gate) or — for tests and
 *      early-boot — the raw host bridge.
 *   5. Unmounts on alt-screen exit, releasing listeners so the Composer can
 *      receive keystrokes again.
 *
 * Mode mirror
 * -----------
 * The encoder layer reads live mode state via `ModeSnapshot(GridMirrorLike)`
 * — `bracketedPaste`, `mouseTracking`, `decckm`, `kittyKeyboard` etc. There
 * is no central per-session GridMirror exposed to React yet (the in-tree
 * mirrors live inside BlockCard instances and a future TerminalCanvas host),
 * so we build a LOCAL stub mirror seeded with alt-screen-sensible defaults:
 * bracketed-paste off (vim handles its own paste buffer), mouse tracking off
 * (apps negotiate via DECSET 1000/1002/1003 when they want it), legacy key
 * encoding. Apps that negotiate more modes simply won't see their modes
 * reflected in THIS mirror until the session-scoped mirror is plumbed in a
 * later pass; the impact is bounded to the minority of features that read
 * the mirror (bracketed-paste + mouse wire-encoding). Core TUI usage — arrow
 * keys, Ctrl+C, Esc, paste — works unconditionally through the legacy path.
 *
 * Focus competition
 * -----------------
 * The surface auto-focuses on mount and refocuses on re-click. The Composer
 * is still rendered (so its layout bounds stay stable across TUI flicker)
 * but wrapped in an `aria-hidden` / `inert`-styled container that blocks it
 * from pointer capture and strips its tab-stop. On alt-screen exit the
 * Composer's own autoFocus (or a following user click) restores focus.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HostBridge } from '@quanta/host-common';

import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { createLogger } from '../../shared/lib/logger.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { isMac } from '../../shared/lib/keymap.js';
import { t } from '../../shared/i18n/index.js';
import {
  Focus,
  KeyEncoder,
  ModeSnapshot,
  MouseEncoder,
  Paste,
  createStubMirror,
  mount,
  type InputHostHandle,
} from '../input/index.js';
import {
  analyze as analyzePaste,
  needsConfirmation,
  PasteConfirmDialog,
  type PasteAnalysis,
} from '../paste-safety/index.js';
import { getSessionConnection } from '../session-tabs/index.js';

import styles from './tui-input-surface.module.css';

const log = createLogger('tui.input-surface');

/**
 * Encoded PTY bytes → bridge string. The host's `write(sessionId, data)`
 * contract is a UTF-8 string; the sidecar converts to bytes via `as_bytes()`.
 * All encoded sequences from our input encoders are either:
 *   - 7-bit ASCII (control codes, CSI sequences, SGR mouse params), which
 *     round-trips losslessly through UTF-8, OR
 *   - UTF-8 payloads embedded in a bracketed paste, which the paste encoder
 *     already assembles from a `TextEncoder` call against the source text.
 *
 * Using a non-fatal UTF-8 decoder here keeps us safe against defensive
 * assumptions (an encoder returning a stray high byte) — the decoder emits
 * U+FFFD and the wire stays shaped.
 */
const BYTES_DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

function bytesToWireString(bytes: Uint8Array): string {
  return BYTES_DECODER.decode(bytes);
}

/**
 * Dispatch encoded bytes to the PTY. We prefer the session-tabs connection
 * because its `write()` wrapper honors the degraded-mode gate (ADR 0010 /
 * RFC §20); the raw host bridge is the fallback for tests or for the very
 * early-boot window where the connection map hasn't been populated yet.
 */
async function writeToSession(
  sessionId: SessionId,
  bridge: HostBridge,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length === 0) return;
  const payload = bytesToWireString(bytes);
  const conn = getSessionConnection(sessionId);
  try {
    if (conn) {
      await conn.write(payload);
    } else {
      await bridge.write(sessionId, payload);
    }
  } catch (err) {
    log.warn('tui-input-surface: write rejected', err);
  }
}

export interface TuiInputSurfaceProps {
  /** Session the alt-screen program is running under. */
  readonly sessionId: SessionId | null;
  /**
   * Optional bridge override for tests. Falls back to `tryGetHostBridge()`.
   */
  readonly bridge?: HostBridge;
  /**
   * Optional hook fired with the encoded byte stream. Tests use this to
   * assert wire-level output without mocking the host bridge transport.
   */
  readonly onBytesOut?: (bytes: Uint8Array) => void;
}

/**
 * Alt-screen-gated input sink. Returns `null` when no TUI program is active,
 * so in the common (non-alt-screen) case the Composer owns focus and no
 * listener hops off the DOM.
 */
export function TuiInputSurface(props: TuiInputSurfaceProps): JSX.Element | null {
  const { sessionId, bridge: bridgeProp, onBytesOut } = props;
  const { active } = useAltScreenMode();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bridge = bridgeProp ?? tryGetHostBridge();

  // Paste-safety: when a risky paste lands on the surface we stash it in
  // state, show the confirmation dialog, and only resolve the gate promise
  // when the user makes a choice. Using a ref for the pending-resolver
  // keeps the dialog's confirm/cancel handlers plain React callbacks.
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pasteAnalysis, setPasteAnalysis] = useState<PasteAnalysis | null>(null);
  const pendingResolverRef = useRef<((allowed: boolean) => void) | null>(null);

  const onPasteGate = useCallback(
    (text: string): boolean | Promise<boolean> => {
      const analysis = analyzePaste(text);
      if (!needsConfirmation(analysis)) return true;
      return new Promise<boolean>((resolve) => {
        pendingResolverRef.current = resolve;
        setPendingPaste(text);
        setPasteAnalysis(analysis);
      });
    },
    [],
  );

  const resolvePasteDecision = useCallback((allowed: boolean): void => {
    const resolver = pendingResolverRef.current;
    pendingResolverRef.current = null;
    setPendingPaste(null);
    setPasteAnalysis(null);
    resolver?.(allowed);
  }, []);

  // Escape-hatch keyboard interceptor. Users can always release the keyboard
  // back to the shell with Cmd+Shift+Esc on macOS (or Ctrl+Shift+Esc on other
  // platforms) even when the TUI has captured all input. We install the
  // listener in the capture phase so we win the event before the input-host
  // KeyEncoder has a chance to forward Escape as a plain 0x1b byte.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!e.shiftKey) return;
      const modifierHeld = isMac() ? e.metaKey : e.ctrlKey;
      if (!modifierHeld) return;
      e.preventDefault();
      e.stopPropagation();
      // Best-effort: tell the TUI program to exit the alt-screen + restore
      // the cursor. The bytes are dispatched through the same transport as
      // normal keystrokes so the degraded-gate is still consulted.
      if (sessionId && bridge) {
        const ESC_EXIT = new Uint8Array([
          0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c, // ESC [ ? 1 0 4 9 l
          0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68, // ESC [ ? 2 5 h
        ]);
        onBytesOut?.(ESC_EXIT);
        void writeToSession(sessionId, bridge, ESC_EXIT);
      }
      // Force the UI store back to the non-TUI state regardless of whether
      // the program honors the alt-screen exit bytes — the user requested a
      // hard release.
      useTuiStore.getState().reset();
    };
    container.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      container.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [active, sessionId, bridge, onBytesOut]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    if (!sessionId || !bridge) {
      // Nothing actionable: we still want to render the surface (so the
      // Composer stays dimmed and the overlay blocks pointer capture), but
      // there is no route for the bytes. A single debug line is enough —
      // this state only happens during spawn-failed boots.
      log.debug('tui-input-surface: active without session/bridge; noop');
      return;
    }

    // Build a per-mount stub mirror. See file-header "Mode mirror" note
    // for why this is a stub and what it means for feature coverage.
    //
    // Seed `altScreen: true` — this surface is only mounted when the tui
    // store reports an active alt-screen program, so the mirror must
    // reflect that. Critically, MouseEncoder's wheel→arrow-key fallback
    // reads this flag to decide whether to synthesize arrow bytes when
    // mouse tracking is off (alt-screen has no native scroll).
    const mirror = createStubMirror({ altScreen: true });
    const modeSnapshot = new ModeSnapshot(mirror);
    const keyEncoder = new KeyEncoder({ modeSnapshot });
    const mouseEncoder = new MouseEncoder({ modeSnapshot });
    const paste = new Paste({ modeSnapshot });
    const focus = new Focus({ modeSnapshot });

    let handle: InputHostHandle | null = null;
    try {
      handle = mount(container, {
        keyEncoder,
        mouseEncoder,
        paste,
        focus,
        onBytesOut: (bytes) => {
          onBytesOut?.(bytes);
          void writeToSession(sessionId, bridge, bytes);
        },
        onPasteGate,
      });
    } catch (err) {
      log.warn('tui-input-surface: mount failed', err);
      return;
    }

    // Auto-focus so keystrokes land here instead of the Composer on entry.
    // Some environments (jsdom) throw from .focus() on detached or hidden
    // elements — swallow so tests stay green.
    try {
      container.focus();
    } catch {
      /* ignore */
    }

    const onPointerDown = () => {
      try {
        container.focus();
      } catch {
        /* ignore */
      }
    };
    container.addEventListener('pointerdown', onPointerDown);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      handle?.unmount();
    };
  }, [active, sessionId, bridge, onBytesOut, onPasteGate]);

  if (!active) return null;

  return (
    <>
      <div
        ref={containerRef}
        className={styles.tuiInputSurface}
        tabIndex={0}
        role="application"
        aria-label={t('tui.input.ariaLabel')}
        aria-roledescription="terminal"
        data-testid="tui-input-surface"
      />
      <PasteConfirmDialog
        text={pendingPaste}
        analysis={pasteAnalysis}
        onCancel={() => resolvePasteDecision(false)}
        onConfirm={() => resolvePasteDecision(true)}
      />
    </>
  );
}

TuiInputSurface.displayName = 'TuiInputSurface';
