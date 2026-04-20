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
import { VtEmulator } from '../../shared/lib/vt-emulator/index.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
  type Platform,
} from '../../shared/ui/cell-renderer/index.js';
import { TerminalCanvas } from '../../widgets/terminal-canvas/index.js';
import { base64ToBytes } from '../../shared/lib/base64.js';
import { useAltScreenMode } from '../../entities/tui/index.js';
import { createLogger } from '../../shared/lib/logger.js';
import styles from './tui-render-surface.module.css';

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
    const emulator = new VtEmulator({
      sessionId: `tui-${sessionId}`,
      rows: 24,
      cols: 80,
      onEnvelope: (env) => {
        mirror.apply(env);
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

  const backendKind = useMemo(() => resolveBackendKind(), []);
  const platform = useMemo(() => detectPlatform(), []);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className={styles['tuiRenderSurface']!}
      data-testid="tui-render-surface"
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
    </div>
  );
}

TuiRenderSurface.displayName = 'TuiRenderSurface';
