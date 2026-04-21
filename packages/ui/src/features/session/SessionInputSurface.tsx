/**
 * SessionInputSurface — always-on DOM sink routing keyboard / pointer /
 * wheel / paste / focus / IME events to the PTY whenever a session is
 * active (Epic β, Plan 0005 §4.β).
 *
 * Lineage
 * -------
 * Generalization of the former `features/tui/TuiInputSurface`. That
 * component gated on `useAltScreenMode().active` so only alt-screen
 * programs (vim, htop, less, ...) captured input; the legacy Composer
 * buffered every other keystroke client-side until Enter. With the
 * Warp-style redesign (Plan 0005), the Composer is transitional: it still
 * renders below the chrome and still submits on Enter via `submitCommand`,
 * but the goal is byte-for-byte shell routing. This surface is the piece
 * that unlocks that story — it always mounts while a session is active
 * and forwards every DOM event through the `input-host` encoders.
 *
 * What is captured here
 * ---------------------
 *   - Key events: all of them, except those matched by `keymapGuard` (UI
 *     shortcuts: Cmd+K palette, Cmd+T tab, Cmd+D split, etc. — see
 *     `./KeymapGuard.ts`). Everything else (Ctrl+C, arrows, Tab, Enter,
 *     plain printables) flows through `KeyEncoder` and lands on the wire.
 *   - Pointer + wheel: translated by `MouseEncoder` when the app requests
 *     mouse tracking; wheel-in-alt-screen synthesizes arrow keystrokes.
 *   - Paste: the native `paste` event is intercepted by `Paste`, which
 *     also runs the optional `onPasteGate` for paste-safety confirmation.
 *   - Focus / blur: emits DSR 1004 enter/leave when the app enabled focus
 *     reporting via DECSET 1004.
 *   - IME composition: `ImeStateMachine` funnels compositionstart /
 *     update / end into buffered overlay state and commits UTF-8 bytes on
 *     composition-end, so CJK IMEs work in the shell.
 *
 * Composer coexistence
 * --------------------
 * The surface and the Composer textarea coexist during this transitional
 * phase. The surface captures events that fire OUTSIDE the composer's
 * textarea; events inside the textarea bubble to its own handlers so
 * Enter still submits via the legacy `submitCommand` path. This lets the
 * team flip `flag.blockUx` in Epic δ to unmount the Composer in the
 * default renderer — only then does every keystroke land on the wire.
 * Until then: click anywhere outside the composer → keystrokes go
 * byte-for-byte to the PTY via THIS surface.
 *
 * Focus policy
 * ------------
 * On mount (session-active flips on) we `.focus()` the surface. When a
 * UI overlay opens (command palette, settings) its focus-trap steals
 * focus; on close, that overlay refocuses the previous element which —
 * for users who were typing into the terminal — is this surface again.
 * Our `pointerdown` listener re-focuses on click so stray clicks on the
 * chrome don't leave focus in limbo.
 *
 * Mode mirror
 * -----------
 * The encoder layer reads live mode state via `ModeSnapshot(GridMirrorLike)`.
 * There is no central per-session GridMirror exposed to React yet (the
 * in-tree mirrors live inside BlockCard instances and a future
 * TerminalSurface host — Epic δ); until then we seed a local stub mirror
 * with session-sensible defaults. Alt-screen-sensitive features (mouse
 * wheel-to-arrow fallback) read the stub's `altScreen` flag which we
 * mirror from `useAltScreenMode()` on every mount.
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
import { tryGetDegradedGate } from '../degraded-mode/index.js';

import { defaultKeymapGuard } from './KeymapGuard.js';

import styles from './session-input-surface.module.css';

const log = createLogger('session.input-surface');

/**
 * Encoded PTY bytes → bridge string. The host's `write(sessionId, data)`
 * contract is a UTF-8 string; the sidecar converts to bytes via `as_bytes()`.
 * All encoded sequences from our input encoders are either:
 *   - 7-bit ASCII (control codes, CSI sequences, SGR mouse params), which
 *     round-trips losslessly through UTF-8, OR
 *   - UTF-8 payloads embedded in a bracketed paste / IME commit, which
 *     the encoders already assemble from a `TextEncoder` call against the
 *     source text.
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
    log.warn('session-input-surface: write rejected', err);
  }
}

export interface SessionInputSurfaceProps {
  /** Session that receives routed bytes. Nothing mounts while this is null. */
  readonly sessionId: SessionId | null;
  /** Optional bridge override for tests. Falls back to `tryGetHostBridge()`. */
  readonly bridge?: HostBridge;
  /**
   * Guard predicate: when it returns `true`, the keystroke is handled by
   * the UI (e.g. command-palette shortcut) and MUST NOT be forwarded to
   * the encoder. Defaults to `defaultKeymapGuard` which covers the P0
   * shortcut list (Cmd+K / Cmd+T / Cmd+D / …).
   */
  readonly keymapGuard?: (ev: KeyboardEvent) => boolean;
  /**
   * Test hook fired with the encoded byte stream. Lets tests assert
   * wire-level output without mocking the host bridge transport format.
   */
  readonly onBytesOut?: (bytes: Uint8Array) => void;
  /**
   * Test hook fired whenever the `keymapGuard` claims a keystroke. Exists
   * so tests can assert that Cmd+K (et al) did NOT encode.
   */
  readonly onKeymapGuardClaim?: (ev: KeyboardEvent) => void;
}

/**
 * Always-on input sink. Renders `null` only when no session is active
 * (sessionId is null) so the component is a true no-op at boot before the
 * first session spawns.
 */
export function SessionInputSurface(
  props: SessionInputSurfaceProps,
): JSX.Element | null {
  const {
    sessionId,
    bridge: bridgeProp,
    keymapGuard = defaultKeymapGuard,
    onBytesOut,
    onKeymapGuardClaim,
  } = props;
  const { active: altScreenActive } = useAltScreenMode();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bridge = bridgeProp ?? tryGetHostBridge();

  // Paste-safety: when a risky paste lands on the surface we stash it in
  // state, show the confirmation dialog, and only resolve the gate
  // promise when the user makes a choice. Using a ref for the pending-
  // resolver keeps the dialog's confirm/cancel handlers plain React
  // callbacks.
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
    // Degraded-mode policy: even when the user clicked "Allow" on the
    // paste-safety dialog, if the session is degraded at resolve time we
    // must NOT put the bytes on the wire. The `onByteGate` below would
    // catch them anyway — but telling the paste encoder "denied" here
    // means we don't waste an encode + gate round-trip, and the
    // dropped-input counter still increments via the byte gate (the
    // keystroke path is the canonical accounting site). Cancels are a
    // user-initiated no-op regardless of engine health.
    if (allowed) {
      const gate = tryGetDegradedGate();
      if (gate?.isDegraded()) {
        gate.reportDroppedInput();
        log.debug('paste dropped: session is degraded after user confirm');
        resolver?.(false);
        return;
      }
    }
    resolver?.(allowed);
  }, []);

  // Escape-hatch keyboard interceptor: Cmd+Shift+Esc (mac) or
  // Ctrl+Shift+Esc (elsewhere) forcibly exits alt-screen. We install the
  // listener in the capture phase so we win the event before the encoder
  // forwards Escape as a plain 0x1b byte. Only actionable when an alt-
  // screen program is running.
  useEffect(() => {
    if (sessionId === null) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!e.shiftKey) return;
      const modifierHeld = isMac() ? e.metaKey : e.ctrlKey;
      if (!modifierHeld) return;
      e.preventDefault();
      e.stopPropagation();
      if (!bridge) return;
      const ESC_EXIT = new Uint8Array([
        0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c, // ESC [ ? 1 0 4 9 l
        0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68, // ESC [ ? 2 5 h
      ]);
      onBytesOut?.(ESC_EXIT);
      void writeToSession(sessionId, bridge, ESC_EXIT);
      // Force the UI store back to the non-TUI state regardless of
      // whether the program honors the alt-screen exit bytes — the user
      // requested a hard release.
      useTuiStore.getState().reset();
    };
    container.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      container.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [sessionId, bridge, onBytesOut]);

  // KeymapGuard interceptor. We install this on `window` in the CAPTURE
  // phase so it fires BEFORE the event propagates down the tree to the
  // encoder listener (which input-host attaches to the container in the
  // bubble phase). When the guard claims a key:
  //   - `stopPropagation()` halts the capture chain at window; the event
  //     never reaches the container → the encoder is skipped.
  //   - We do NOT call `preventDefault()` because the global `useKeymap`
  //     listener (also on window) relies on the default key dispatch to
  //     fire its handler. Capture listeners on the same target fire in
  //     registration order; `useKeymap` registers its listener in its
  //     own `useEffect`, which runs before ours when the page mounts,
  //     so its handler gets to observe the event first.
  //   - Target-filtering: we only claim events whose original target is
  //     our surface (or inside it). Events fired on the composer
  //     textarea, the command palette, or any other node pass through
  //     untouched — the guard only fences the bytes we'd otherwise
  //     forward to the PTY.
  useEffect(() => {
    if (sessionId === null) return;
    if (typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDownCapture = (e: KeyboardEvent) => {
      // Only claim events whose target is this surface (or inside it).
      // Events whose target is elsewhere (e.g. composer textarea) are
      // NOT ours to block.
      if (!(e.target instanceof Node) || !container.contains(e.target as Node)) {
        return;
      }
      // Escape-hatch already ran in the container-level capture listener
      // above; if it claimed the event, `defaultPrevented` is true.
      if (e.defaultPrevented) return;
      if (!keymapGuard(e)) return;
      // Claimed by UI. Stop propagation so the encoder (which listens on
      // the container in the bubble phase) never receives it, but do NOT
      // stopImmediatePropagation — other window-level capture listeners
      // may be legitimately inspecting the same event. The
      // `useKeymap(...)` listener is ALSO a window-level listener, but
      // it was added AFTER this one (component mount runs useEffect
      // after useKeymap's effect has already registered the listener on
      // window). DOM guarantees listeners fire in registration order for
      // the same phase, so the keymap handler has already run by the
      // time we're here — OR it will run later in the same phase. Both
      // orderings are safe because the guard doesn't cancel the event.
      e.stopPropagation();
      onKeymapGuardClaim?.(e);
    };
    // Capture phase on window → fires before the container's target
    // listeners (encoder).
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [sessionId, keymapGuard, onKeymapGuardClaim]);

  useEffect(() => {
    if (sessionId === null) return;
    const container = containerRef.current;
    if (!container) return;
    if (!bridge) {
      log.debug('session-input-surface: active without bridge; noop');
      return;
    }

    // Build a per-mount stub mirror. The `altScreen` flag is seeded from
    // the tui store so MouseEncoder's wheel→arrow-key fallback lights up
    // while vim/less/etc. are active. Ordinary shell sessions keep the
    // default scroll behavior because nothing mounts a wheel encoder
    // fallback without altScreen=true.
    const mirror = createStubMirror({ altScreen: altScreenActive });
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
        // Degraded-mode suppression (RFC §20 + ADR 0010). Sits between
        // the encoder and the bridge: the encoders are mode-aware, but
        // degraded means "PTY is unreachable" — we don't care what DECCKM
        // thinks, we just refuse to put bytes on the wire. The counter
        // bumps once PER DROPPED EVENT (a 7-byte CSI emit still counts
        // as one drop), because the user's intent was one keystroke, not
        // seven bytes. Source attribution lets future panels surface
        // "N keystrokes / M mouse events dropped while offline".
        onByteGate: (bytes, source) => {
          const gate = tryGetDegradedGate();
          if (gate?.isDegraded()) {
            gate.reportDroppedInput();
            log.debug('input dropped: session is degraded', {
              source,
              byteCount: bytes.length,
            });
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      log.warn('session-input-surface: mount failed', err);
      return;
    }

    // Auto-focus so keystrokes land here on session-active. jsdom throws
    // from `.focus()` on detached / hidden elements — swallow so tests
    // stay green.
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
  }, [sessionId, bridge, altScreenActive, onBytesOut, onPasteGate]);

  if (sessionId === null) return null;

  return (
    <>
      <div
        ref={containerRef}
        className={styles.sessionInputSurface}
        tabIndex={0}
        role="application"
        aria-label={t('tui.input.ariaLabel')}
        aria-roledescription="terminal"
        data-testid="session-input-surface"
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

SessionInputSurface.displayName = 'SessionInputSurface';
