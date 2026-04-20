/**
 * TerminalCanvas — React hosting widget for the EPIC-D cell renderer.
 *
 * Responsibilities:
 *   - Mount the active backend (`canvas` or `memory`) into a positioned
 *     container.
 *   - Wire the mirror's dirty-row signal → `CellBuffer` → `Renderer`.
 *   - Route pointer events through `HitTest` and feed `SelectionManager`.
 *   - Expose an `imeOverlaySlot` render prop consumed by EPIC-E's
 *     `PreeditOverlay`.
 *   - Expose a `hyperlinkPolicy` callback that fires on Cmd/Ctrl+click over
 *     a hyperlinked cell.
 *
 * Invariants:
 *   - I-3 (Grid is truth): the widget reads the mirror; it never mutates
 *     cell state. Selection / search / copy live on top of the mirror.
 *   - I-4 (Semantic width wins): hit-test and selection use the width SSOT
 *     via `CellBuffer.getCell(...).cols` — this widget never calls a
 *     width classifier directly.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type {
  CursorState,
  Row,
  TerminalModeState,
} from '../../shared/lib/grid-mirror/index.js';
import {
  Canvas2DBackend,
  CellBuffer,
  DEFAULT_METRICS,
  HitTest,
  MemoryBackend,
  MirrorSource,
  Renderer,
  Search,
  SelectionManager,
  type BackendContract,
  type CellMetrics,
  type IMEOverlayAnchor,
  type Platform,
  type Rect,
  type ScreenHit,
  type SelectionAnchor,
  type SelectionMode,
  type SelectionState,
} from '../../shared/ui/cell-renderer/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './terminal-canvas.module.css';

export type TerminalCanvasBackendKind = 'canvas' | 'memory';

export interface TerminalCanvasHandle {
  readonly mirrorSource: MirrorSource;
  readonly cellBuffer: CellBuffer;
  readonly renderer: Renderer;
  readonly selection: SelectionManager;
  readonly search: Search;
  readonly hitTest: HitTest;
  readonly backend: BackendContract;
  /**
   * Force the buffer + backend to resync with the mirror. Consumed by tests
   * and by the EPIC-C snapshot-applied callback path.
   */
  applySnapshot(rows: readonly Row[], cursor: CursorState | null, mode: TerminalModeState): void;
  applyDelta(rows: readonly Row[], dirtyRows: Iterable<number>): void;
  applyMetrics(metrics: CellMetrics, dpr: number): void;
}

export interface TerminalCanvasProps {
  /** Grid mirror — EPIC-C authoritative source. */
  readonly mirror: GridMirror;
  /** Source that fires when the mirror signals dirty rows. */
  readonly mirrorSource: MirrorSource;
  /** Backend kind. Default `'canvas'`. */
  readonly backend?: TerminalCanvasBackendKind;
  /** Cell metrics. Default DEFAULT_METRICS (jsdom-friendly). */
  readonly metrics?: CellMetrics;
  /** DPR override (default `window.devicePixelRatio` if available, else 1). */
  readonly dpr?: number;
  /** Platform — used for block-mode modifier + hyperlink-click modifier. */
  readonly platform?: Platform;
  /** Callback when a hyperlink is clicked (Cmd on macOS, Ctrl elsewhere). */
  readonly onHyperlinkClick?: (ev: { id: number; uri: string | null; modifiers: string[] }) => void;
  /** Hover over a hyperlink. */
  readonly onHyperlinkHover?: (uri: string | null) => void;
  /** Fires when the user releases a drag — consumers may `copy()`. */
  readonly onSelectionChange?: (sel: SelectionState | null) => void;
  /** Copy request — fires on Cmd+C / Ctrl+C. The consumer writes to clipboard. */
  readonly onCopyRequest?: (text: string) => void;
  /** Render-prop for the IME overlay. Passed the current anchor or null. */
  readonly imeOverlaySlot?: (anchor: IMEOverlayAnchor | null) => ReactNode;
  /** Class name passthrough. */
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Data-renderer attr for EPIC-H side-by-side diff harness. */
  readonly 'data-renderer'?: string;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

function makeBackend(kind: TerminalCanvasBackendKind, metrics: CellMetrics): BackendContract {
  switch (kind) {
    case 'memory':
      return new MemoryBackend(metrics);
    case 'canvas':
    default:
      return new Canvas2DBackend();
  }
}

function platformBlockModeModifier(platform: Platform): 'altKey' | 'metaKey' {
  // Opt (altKey in DOM events) on macOS; Alt (altKey) elsewhere. Both map to
  // the same event field; retained as a helper for future per-platform tweak.
  void platform;
  return 'altKey';
}

function platformHyperlinkModifier(platform: Platform): 'metaKey' | 'ctrlKey' {
  return platform === 'macos' ? 'metaKey' : 'ctrlKey';
}

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

/** Enumerate the rectangles that cover `sel` (one per visual row). */
function selectionRects(
  sel: SelectionState | null,
  buffer: CellBuffer,
  hit: HitTest,
): Rect[] {
  if (!sel) return [];
  const out: Rect[] = [];
  const { start, end, mode } = sel;
  const top = Math.min(start.row, end.row);
  const bottom = Math.max(start.row, end.row);
  if (mode === 'block') {
    const left = Math.min(start.col, end.col);
    const right = Math.max(start.col, end.col);
    for (let r = top; r <= bottom; r += 1) {
      const tl = hit.cellToScreen(r, left);
      const br = hit.cellToScreen(r, Math.max(left, right - 1));
      out.push({
        x: tl.x,
        y: tl.y,
        width: br.x + br.width - tl.x,
        height: tl.height,
      });
    }
    return out;
  }
  const n = normalize(sel);
  const cols = buffer.dimensions().cols;
  for (let r = n.start.row; r <= n.end.row; r += 1) {
    const l = r === n.start.row ? n.start.col : 0;
    const rCol = r === n.end.row ? n.end.col : cols;
    if (rCol <= l) continue;
    const tl = hit.cellToScreen(r, l);
    const br = hit.cellToScreen(r, Math.max(l, rCol - 1));
    out.push({
      x: tl.x,
      y: tl.y,
      width: br.x + br.width - tl.x,
      height: tl.height,
    });
  }
  return out;
}

function normalize(sel: SelectionState): SelectionState {
  const swap =
    sel.start.row > sel.end.row ||
    (sel.start.row === sel.end.row && sel.start.col > sel.end.col);
  if (!swap) return sel;
  return { start: sel.end, end: sel.start, mode: sel.mode };
}

export const TerminalCanvas = forwardRef<TerminalCanvasHandle, TerminalCanvasProps>(
  function TerminalCanvas(props, ref) {
    const {
      mirror,
      mirrorSource,
      backend: backendKind = 'canvas',
      metrics = DEFAULT_METRICS,
      dpr: dprProp,
      platform: platformProp,
      onHyperlinkClick,
      onHyperlinkHover,
      onSelectionChange,
      onCopyRequest,
      imeOverlaySlot,
      className,
      style,
    } = props;

    const dataRenderer = props['data-renderer'] ?? backendKind;
    const [selection, setSelection] = useState<SelectionState | null>(null);
    const [imeAnchor] = useState<IMEOverlayAnchor | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const platform = useMemo(() => platformProp ?? detectPlatform(), [platformProp]);

    // Core plumbing — CellBuffer / Renderer / HitTest / Selection / Search.
    // Re-create on backend change (rare) or mirror identity change.
    const plumbingRef = useRef<{
      backend: BackendContract;
      buffer: CellBuffer;
      renderer: Renderer;
      hitTest: HitTest;
      selection: SelectionManager;
      search: Search;
      backendKind: TerminalCanvasBackendKind;
    } | null>(null);

    // Lazy init of the plumbing (on demand; keeps SSR happy).
    const ensurePlumbing = useCallback(() => {
      if (plumbingRef.current && plumbingRef.current.backendKind === backendKind) {
        return plumbingRef.current;
      }
      // Tear down old.
      if (plumbingRef.current) {
        plumbingRef.current.renderer.dispose();
        plumbingRef.current.buffer.dispose();
        plumbingRef.current.backend.unmount();
      }
      const buffer = new CellBuffer(mirrorSource, mirror.getDimensions());
      const backendInstance = makeBackend(backendKind, metrics);
      const renderer = new Renderer(backendInstance, buffer, mirrorSource);
      const hitTest = new HitTest(buffer, metrics);
      const selectionManager = new SelectionManager(buffer);
      const search = new Search(buffer);
      renderer.setRowFetcher((r) => mirror.getRow(r));
      plumbingRef.current = {
        backend: backendInstance,
        buffer,
        renderer,
        hitTest,
        selection: selectionManager,
        search,
        backendKind,
      };
      return plumbingRef.current;
    }, [backendKind, metrics, mirror, mirrorSource]);

    // Mount effect — backend lifecycle + initial snapshot.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const plumbing = ensurePlumbing();
      const dpr = dprProp ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
      plumbing.backend.mount({ container: el, metrics, dpr });
      plumbing.hitTest.applyMetrics(metrics);
      // Wire the backend's font-load / visibility invalidation hook so that
      // a late web-font arrival OR a tab refocus forces a fresh rAF tick.
      // The hook re-rasters every visible row by marking all rows dirty
      // and scheduling a frame; without this the atlas gets emptied by
      // the backend but the renderer has nothing new to draw so the frame
      // remains in the stale fallback-font state.
      const maybeSetHook = (
        plumbing.backend as BackendContract & {
          _setInvalidationHook?: (hook: (() => void) | null) => void;
        }
      )._setInvalidationHook;
      if (typeof maybeSetHook === 'function') {
        maybeSetHook.call(plumbing.backend, () => {
          const dims2 = mirror.getDimensions();
          const damage = plumbing.buffer.peekDamage();
          for (let r = 0; r < dims2.rows; r += 1) damage.addRow(r);
          plumbing.renderer.scheduleFrame();
        });
      }
      // Seed with the mirror's current state.
      const dims = mirror.getDimensions();
      const rows: Row[] = [];
      for (let r = 0; r < dims.rows; r += 1) {
        const row = mirror.getRow(r);
        if (row) rows.push(row);
      }
      plumbing.backend.applyGridSnapshot(rows, mirror.getCursor(), mirror.getMode());
      plumbing.buffer.writeSnapshot(rows);
      plumbing.renderer.start();
      return () => {
        if (typeof maybeSetHook === 'function') {
          maybeSetHook.call(plumbing.backend, null);
        }
        plumbing.renderer.dispose();
        plumbing.buffer.dispose();
        plumbing.backend.unmount();
        plumbingRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backendKind, mirror, mirrorSource]);

    // Selection subscription — forward to consumer + trigger re-render
    // of the highlight rects.
    useEffect(() => {
      const plumbing = plumbingRef.current ?? ensurePlumbing();
      const unsub = plumbing.selection.onSelectionChange((s) => {
        setSelection(s);
        onSelectionChange?.(s);
        plumbing.renderer.markOverlayDirty();
      });
      return () => {
        unsub();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ensurePlumbing, onSelectionChange]);

    // Imperative handle.
    useImperativeHandle(
      ref,
      () => {
        const plumbing = plumbingRef.current ?? ensurePlumbing();
        const handle: TerminalCanvasHandle = {
          mirrorSource,
          cellBuffer: plumbing.buffer,
          renderer: plumbing.renderer,
          selection: plumbing.selection,
          search: plumbing.search,
          hitTest: plumbing.hitTest,
          backend: plumbing.backend,
          applySnapshot(rows, cursor, mode) {
            plumbing.backend.applyGridSnapshot(rows, cursor, mode);
            plumbing.buffer.writeSnapshot(rows);
            plumbing.renderer.applyMode(mode);
            plumbing.renderer.markCursorDirty(cursor);
          },
          applyDelta(rows, dirtyRowIds) {
            for (const r of dirtyRowIds) plumbing.buffer.peekDamage().addRow(r);
            // Reflect delta into buffer.
            for (const row of rows) {
              // We need a row index; callers pass rows aligned with dirtyRowIds.
              // A simpler path: let the renderer pull rows via rowFetcher on
              // its next tick.
              void row;
            }
            plumbing.renderer.scheduleFrame();
          },
          applyMetrics(nextMetrics, dpr) {
            plumbing.backend.applyMetrics(nextMetrics, dpr);
            plumbing.hitTest.applyMetrics(nextMetrics);
          },
        };
        return handle;
      },
      [ensurePlumbing, mirrorSource],
    );

    // Pointer handlers.
    const activeDragRef = useRef<{ anchor: SelectionAnchor; mode: SelectionMode } | null>(null);

    const screenHitFromEvent = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>): ScreenHit | null => {
        const plumbing = plumbingRef.current;
        if (!plumbing) return null;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return plumbing.hitTest.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
      },
      [],
    );

    const onPointerDown = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        const hit = screenHitFromEvent(e);
        if (!hit) return;
        const plumbing = plumbingRef.current;
        if (!plumbing) return;
        const hyperlinkModifier = platformHyperlinkModifier(platform);
        const modifierPressed = Boolean(e[hyperlinkModifier]);
        // Cmd/Ctrl+click on a hyperlink fires onHyperlinkClick and suppresses
        // selection.
        if (modifierPressed && hit.hyperlinkId !== null && hit.hyperlinkId > 0) {
          const resolved = mirror.resolveHyperlink(hit.hyperlinkId);
          const modifiers: string[] = [];
          if (e.metaKey) modifiers.push('meta');
          if (e.ctrlKey) modifiers.push('ctrl');
          if (e.shiftKey) modifiers.push('shift');
          if (e.altKey) modifiers.push('alt');
          onHyperlinkClick?.({
            id: resolved.id,
            uri: resolved.uri,
            modifiers,
          });
          return;
        }
        // Multi-click → word / line mode.
        let mode: SelectionMode = 'char';
        if (e.detail === 2) mode = 'word';
        else if (e.detail >= 3) mode = 'line';
        // Alt/Opt held → block mode.
        const blockModifier = platformBlockModeModifier(platform);
        if (e[blockModifier]) mode = 'block';
        plumbing.selection.begin({ row: hit.row, col: hit.col }, mode);
        activeDragRef.current = { anchor: { row: hit.row, col: hit.col }, mode };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      },
      [mirror, onHyperlinkClick, platform, screenHitFromEvent],
    );

    const onPointerMove = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        const plumbing = plumbingRef.current;
        if (!plumbing) return;
        const hit = screenHitFromEvent(e);
        if (!hit) return;
        if (hit.hyperlinkId !== null && hit.hyperlinkId > 0 && onHyperlinkHover) {
          const resolved = mirror.resolveHyperlink(hit.hyperlinkId);
          onHyperlinkHover(resolved.uri);
        } else if (onHyperlinkHover) {
          onHyperlinkHover(null);
        }
        if (!activeDragRef.current) return;
        plumbing.selection.extend({ row: hit.row, col: hit.col });
      },
      [mirror, onHyperlinkHover, screenHitFromEvent],
    );

    const onPointerUp = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        void e;
        activeDragRef.current = null;
      },
      [],
    );

    // Keyboard shortcut: Cmd+C / Ctrl+C → copy.
    const onKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const plumbing = plumbingRef.current;
        if (!plumbing) return;
        const copyModifier = platform === 'macos' ? e.metaKey : e.ctrlKey;
        if (copyModifier && (e.key === 'c' || e.key === 'C')) {
          const text = plumbing.selection.copy();
          if (text) {
            onCopyRequest?.(text);
            e.preventDefault();
          }
        }
      },
      [onCopyRequest, platform],
    );

    // Compute selection highlight rects lazily.
    const selectionRectList = useMemo(() => {
      const plumbing = plumbingRef.current;
      if (!plumbing || !selection) return [];
      return selectionRects(selection, plumbing.buffer, plumbing.hitTest);
    }, [selection]);

    return (
      <div
        ref={containerRef}
        className={cx(styles.container, className)}
        style={style}
        tabIndex={0}
        role="application"
        aria-label="terminal-canvas"
        data-renderer={dataRenderer}
        data-platform={platform}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {selectionRectList.map((rect, i) => (
          <div
            key={`sel-${i}`}
            className={styles.selection}
            style={rectStyle(rect)}
            data-testid="terminal-canvas-selection"
          />
        ))}
        <div className={styles.imeSlot} data-testid="terminal-canvas-ime-slot">
          {imeOverlaySlot ? imeOverlaySlot(imeAnchor) : null}
        </div>
      </div>
    );
  },
);
