/**
 * TuiRenderSurface — full-viewport grid painter for alt-screen TUI apps.
 *
 * **Option B (grid) rewrite.** The previous iteration streamed PTY bytes
 * through `AnsiParser` → `AnsiOutput` which is a linear span pipeline. That
 * only honours CR/BS rewrites, so cursor-addressing TUIs (`vim`, `htop`,
 * `less` with search, etc.) rendered as visually corrupted output. The new
 * pipeline maintains a real 2D grid:
 *
 *   bridge.pty_data bytes
 *        ↓
 *    VtEmulator.feed(bytes)
 *        ↓ (onEnvelope)
 *    GridMirror.apply(envelope)
 *        ↓ (onChange → MirrorSource.emit(dirty))
 *    TerminalCanvas (CellBuffer + Renderer + Canvas2DBackend)
 *
 * Lifecycle:
 *   - Inactive → returns `null`. No emulator / mirror allocated; no
 *     subscription; no ResizeObserver.
 *   - Enter (active flips true, sessionId & bridge non-null): allocate
 *     emulator + mirror + source, subscribe to `pty_data`, observe the
 *     container for resize.
 *   - Exit (active flips false OR the component unmounts): release the
 *     subscription, dispose the mirror, drop the emulator + source.
 *
 * Input routing is owned by `TuiInputSurface` (sibling, z-index: 10). This
 * surface sits *beneath* it; no pointer capture.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostBridge, SessionId } from '@quanta/host-common';
import { VtEmulator, type RgbColor } from '../../shared/lib/vt-emulator/index.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
  type Platform,
} from '../../shared/ui/cell-renderer/index.js';
import { TerminalCanvas } from '../../widgets/terminal-canvas/index.js';
import { base64ToBytes } from '../../shared/lib/base64.js';
import { useAltScreenMode } from '../../entities/tui/index.js';
import { useBellStore } from '../../entities/bell/index.js';
import { useSessionsStore } from '../../entities/session/index.js';
// Protocol-reply routing (DSR / OSC color / primary DA) lives behind the
// single allowlisted response sink in the session feature. TuiRenderSurface
// never calls `bridge.write` directly (see Plan 0005 I-12 / Gate #2); the
// DSR response bytes flow through `writeSessionResponse` so the rule
// continues to see exactly one user-input path AND one protocol-reply path.
import { writeSessionResponse } from '../session/write-response.js';
import { createLogger } from '../../shared/lib/logger.js';
import { t } from '../../shared/i18n/index.js';
import styles from './tui-render-surface.module.css';

/**
 * Read the current theme's fg/bg from CSS custom properties. The ThemeProvider
 * sets `--q-fg` / `--q-bg-terminal` (with `--q-bg` as a secondary fallback) on
 * `document.documentElement`, so `getComputedStyle(root)` gives us whatever is
 * live. When the values don't parse (SSR, unexpected format), we fall back to
 * xterm's historical defaults — white on black — so TUI apps that query always
 * see a plausible colour.
 */
function readThemeColors(): { fg: RgbColor; bg: RgbColor } {
  const fallback: { fg: RgbColor; bg: RgbColor } = {
    fg: { r: 0xe6, g: 0xe8, b: 0xee },
    bg: { r: 0x0b, g: 0x0c, b: 0x10 },
  };
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  try {
    const cs = getComputedStyle(document.documentElement);
    const fg = parseCssColor(cs.getPropertyValue('--q-fg'));
    const bg =
      parseCssColor(cs.getPropertyValue('--q-bg-terminal')) ??
      parseCssColor(cs.getPropertyValue('--q-bg'));
    return {
      fg: fg ?? fallback.fg,
      bg: bg ?? fallback.bg,
    };
  } catch {
    return fallback;
  }
}

/**
 * Parse a CSS color string into an RGB triple. Only `#RGB`, `#RRGGBB`, and
 * `rgb()`/`rgba()` are handled — these are the forms our token sheet uses.
 * Anything else returns `null` and the caller falls back.
 */
function parseCssColor(raw: string): RgbColor | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0], 16);
      const g = parseInt(hex[1]! + hex[1], 16);
      const b = parseInt(hex[2]! + hex[2], 16);
      if (![r, g, b].some((x) => Number.isNaN(x))) return { r, g, b };
      return null;
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (![r, g, b].some((x) => Number.isNaN(x))) return { r, g, b };
      return null;
    }
    return null;
  }
  const m = /^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(v);
  if (m) {
    const r = Math.round(parseFloat(m[1]!));
    const g = Math.round(parseFloat(m[2]!));
    const b = Math.round(parseFloat(m[3]!));
    if (![r, g, b].some((x) => Number.isNaN(x))) return { r, g, b };
  }
  return null;
}

/** Interval between hidden-text-mirror refreshes fed to assistive tech. */
const AT_MIRROR_DEBOUNCE_MS = 200;

const log = createLogger('tui.render-surface');

export interface TuiRenderSurfaceProps {
  readonly sessionId: SessionId | null;
  readonly bridge: HostBridge | null;
}

interface SurfaceCore {
  readonly mirror: GridMirror;
  readonly source: MirrorSource;
  readonly emulator: VtEmulator;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

/**
 * Choose the TerminalCanvas backend. `Canvas2DBackend.mount()` calls
 * `canvas.getContext('2d')` which returns null in jsdom, so component tests
 * force-mount the `'memory'` backend via `window.__quantaTuiBackend__`. Real
 * browsers take the default `'canvas'` path.
 */
function resolveBackendKind(): 'canvas' | 'memory' {
  if (typeof window === 'undefined') return 'canvas';
  const override = (window as unknown as { __quantaTuiBackend__?: 'canvas' | 'memory' })
    .__quantaTuiBackend__;
  if (override === 'memory' || override === 'canvas') return override;
  return 'canvas';
}

/**
 * Full-viewport renderer for alt-screen TUI output.
 *
 * Returns `null` when alt-screen mode is inactive — callers can mount this
 * unconditionally alongside the normal chrome and let the component gate
 * itself on the store.
 */
export function TuiRenderSurface(props: TuiRenderSurfaceProps): JSX.Element | null {
  const { sessionId, bridge } = props;
  const { active } = useAltScreenMode();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Hidden `<pre>` element populated with a plain-text mirror of the grid.
  // Screen readers pick this up via `aria-live`; sighted users never see it.
  const atMirrorRef = useRef<HTMLPreElement | null>(null);
  // We keep the core in state (not just a ref) so that mirror/source are
  // available to the JSX that mounts TerminalCanvas. The effect builds the
  // triple once per (active, sessionId, bridge) tuple and tears it down on
  // cleanup.
  const [core, setCore] = useState<SurfaceCore | null>(null);
  // Emulator needs to be reachable from the ResizeObserver callback without
  // re-running the main effect on every dimension change.
  const coreRef = useRef<SurfaceCore | null>(null);
  coreRef.current = core;

  // Main lifecycle: allocate emulator + mirror + source + subscription.
  useEffect(() => {
    if (!active) return;
    if (sessionId === null || bridge === null) return;

    const source = new MirrorSource();
    const mirror = new GridMirror({
      onChange: (dirty) => source.emit(dirty),
    });
    // Responses to DSR/DA and OSC 10/11 color queries flow straight back to
    // the PTY so apps like vim / neovim see a well-formed terminal. Routing
    // goes through `writeSessionResponse` (the single allowlisted
    // protocol-reply sink in features/session/write-response.ts) so this
    // surface never touches the raw bridge directly — Plan 0005 I-12
    // ("one input path") stays intact because protocol bytes have their
    // own named path and user-input bytes still funnel through
    // SessionInputSurface. Fire-and-forget: writeSessionResponse swallows
    // its own errors at debug; we still guard the rejection so an unhandled
    // promise doesn't bubble.
    const respond = (bytes: Uint8Array): void => {
      if (bytes.length === 0) return;
      void writeSessionResponse(sessionId, bridge, bytes).catch((err: unknown) => {
        log.warn('tui-render-surface: protocol response failed', err);
      });
    };
    const emulator = new VtEmulator({
      sessionId: `tui-${sessionId}`,
      rows: 24,
      cols: 80,
      onEnvelope: (env) => {
        mirror.apply(env);
      },
      onRespond: respond,
      onCwdChanged: (cwd) => {
        // Route straight into the collection store so the tab label and any
        // status-bar CWD consumer pick up the shell-emitted path. Source is
        // 'osc7' so downstream UI can distinguish from shell-integration
        // reports.
        useSessionsStore.getState().patchSession(sessionId, {
          cwd,
          cwdSource: 'osc7',
        });
      },
      themeColors: readThemeColors,
      // Route bare BEL (0x07) into the bell store so the TerminalPage's
      // BellFlash overlay (and optional audible beep) can surface it.
      // OSC / DCS / APC / PM terminators don't reach this hook — the parser
      // distinguishes by FSM state.
      onBell: () => {
        useBellStore.getState().trigger();
      },
    });

    const built: SurfaceCore = { mirror, source, emulator };
    setCore(built);

    const sub = bridge.subscribe((event) => {
      if (event.kind !== 'pty_data') return;
      if (event.sessionId !== sessionId) return;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(event.bytesB64);
      } catch (err) {
        log.warn('tui-render-surface: base64 decode failed', err);
        return;
      }
      emulator.feed(bytes);
    });

    return () => {
      sub.unsubscribe();
      mirror.dispose();
      source.clear();
      setCore(null);
    };
  }, [active, sessionId, bridge]);

  // Resize wiring: observe the container, recompute rows/cols from cell
  // metrics, forward to both the emulator (so the grid model is sized
  // correctly) and the bridge (so the PTY's TIOCSWINSZ matches). Errors
  // from bridge.resize are swallowed — the PTY may already be gone, and
  // treating the error as fatal would propagate into the React tree.
  useEffect(() => {
    if (!active) return;
    if (sessionId === null) return;
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;

    const compute = (): void => {
      const cellW = DEFAULT_METRICS.cellWidthCssPx;
      const cellH = DEFAULT_METRICS.cellHeightCssPx;
      // Width / height can be 0 in jsdom — clamp to 1 so the emulator
      // doesn't blow up on `allocateGrid(0,0)`.
      const cols = Math.max(1, Math.floor((el.clientWidth || cellW) / cellW));
      const rows = Math.max(1, Math.floor((el.clientHeight || cellH) / cellH));
      const emulator = coreRef.current?.emulator;
      if (emulator) {
        const dims = emulator.getDimensions();
        if (dims.rows !== rows || dims.cols !== cols) {
          emulator.resize(rows, cols);
        }
      }
      if (bridge) {
        bridge.resize(sessionId, cols, rows).catch((err: unknown) => {
          log.warn('tui-render-surface: bridge.resize failed', err);
        });
      }
    };

    compute();
    const ro = new ResizeObserver(() => {
      compute();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, bridge, sessionId, core]);

  // Canvas AT fallback: screen readers cannot read glyphs drawn to a
  // `<canvas>`, so we keep a visually-hidden `<pre>` mirror of the grid rows
  // and refresh it on a 200 ms debounce. Each emit coalesces dirty rows into
  // a single textContent write — cheaper than re-rendering a whole tree and
  // keeps us under the screen-reader's announcement cadence.
  useEffect(() => {
    if (!active) return;
    if (!core) return;
    const { mirror, source } = core;

    const render = (): void => {
      const el = atMirrorRef.current;
      if (!el) return;
      const { rows } = mirror.getDimensions();
      const lines: string[] = [];
      for (let r = 0; r < rows; r += 1) {
        const row = mirror.getRow(r);
        if (!row) {
          lines.push('');
          continue;
        }
        let text = '';
        for (const cell of row.cells) {
          text += cell.grapheme || ' ';
        }
        // Trailing whitespace clutters SR output — collapse it.
        lines.push(text.replace(/\s+$/u, ''));
      }
      el.textContent = lines.join('\n');
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        render();
      }, AT_MIRROR_DEBOUNCE_MS);
    };

    const unsub = source.subscribe(() => {
      schedule();
    });
    // Seed the mirror with whatever is already in the grid (e.g. the initial
    // snapshot received before this effect wired up).
    render();

    return () => {
      unsub();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [active, core]);

  const backendKind = useMemo(() => resolveBackendKind(), []);
  const platform = useMemo(() => detectPlatform(), []);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className={styles['tuiRenderSurface']!}
      data-testid="tui-render-surface"
      aria-label={t('tui.render.ariaLabel')}
    >
      {core ? (
        <TerminalCanvas
          mirror={core.mirror}
          mirrorSource={core.source}
          backend={backendKind}
          metrics={DEFAULT_METRICS}
          platform={platform}
          className={styles['tuiCanvas']!}
        />
      ) : null}
      {/* Canvas AT fallback: a visually-hidden text mirror of the grid so
          screen readers can follow the TUI. Debounced to 200 ms so the
          announcement cadence stays sane under high-frequency repaints. */}
      <pre
        ref={atMirrorRef}
        className={styles['tuiAtMirror']!}
        aria-live="polite"
        aria-atomic="false"
        data-testid="tui-at-mirror"
      />
    </div>
  );
}

TuiRenderSurface.displayName = 'TuiRenderSurface';
