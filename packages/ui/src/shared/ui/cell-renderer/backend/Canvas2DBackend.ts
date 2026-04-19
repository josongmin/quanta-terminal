/**
 * Canvas2DBackend — reference `BackendContract` implementation.
 *
 * Draws the grid into a stack of three canvases layered via absolute
 * positioning:
 *   - cell canvas (grid rows, most writes).
 *   - cursor canvas (cursor shape; blink).
 *   - overlay canvas / DOM (IME preedit + selection highlight).
 *
 * jsdom compatibility: jsdom returns `null` from `canvas.getContext('2d')`
 * unless explicit polyfills are installed. We guard all real-canvas calls
 * behind `ctx != null`; when the ctx is missing, the backend records what
 * WOULD have been painted (see `_paintLog`) so the parity suite can still
 * verify the sequence of applyGridDelta / applyCursor / applyMode calls.
 */

import { DefaultClassifier, resolveAmbiguousPolicy } from '../../../lib/width/index.js';
import type {
  CursorState,
  Row,
  TerminalModeState,
} from '../../../lib/grid-mirror/types.js';
import type { DamageSet } from '../DamageSet.js';
import { FontAtlas, MemoryRasterizer } from '../FontAtlas.js';
import type {
  CellMetrics,
  IMEOverlayAnchor,
  OverlayHandle,
  Rect,
  ScreenHit,
} from '../types.js';
import type {
  BackendContract,
  MountContext,
  TextMeasurement,
} from './BackendContract.js';

interface PaintEvent {
  readonly kind:
    | 'mount'
    | 'unmount'
    | 'snapshot'
    | 'delta'
    | 'cursor'
    | 'mode'
    | 'metrics'
    | 'overlay_mount'
    | 'overlay_update'
    | 'overlay_unmount'
    | 'flush';
  readonly rows?: number;
  readonly cursorVisible?: boolean;
}

export class Canvas2DBackend implements BackendContract {
  private container: HTMLElement | null = null;
  private cellCanvas: HTMLCanvasElement | null = null;
  private cursorCanvas: HTMLCanvasElement | null = null;
  private overlayLayer: HTMLDivElement | null = null;
  private cellCtx: CanvasRenderingContext2D | null = null;
  private cursorCtx: CanvasRenderingContext2D | null = null;
  private atlas: FontAtlas | null = null;
  private metrics: CellMetrics = {
    cellWidthPx: 8,
    cellHeightPx: 16,
    baselineOffsetPx: 12,
    cellWidthCssPx: 8,
    cellHeightCssPx: 16,
  };
  private dpr = 1;
  private mode: TerminalModeState = {};
  private readonly classifier = new DefaultClassifier(
    resolveAmbiguousPolicy('auto', 'macos', null),
  );
  private readonly overlays = new Map<symbol, { anchor: IMEOverlayAnchor; el: HTMLSpanElement }>();
  private readonly paintLog: PaintEvent[] = [];
  private gridRows = 0;
  private gridCols = 0;

  mount(ctx: MountContext): void {
    this.container = ctx.container;
    this.metrics = ctx.metrics;
    this.dpr = ctx.dpr;

    // Create layered canvases.
    this.cellCanvas = document.createElement('canvas');
    this.cellCanvas.className = 'quanta-cell-canvas';
    this.cellCanvas.setAttribute('data-layer', 'cells');
    Object.assign(this.cellCanvas.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '1',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    this.cursorCanvas = document.createElement('canvas');
    this.cursorCanvas.className = 'quanta-cursor-canvas';
    this.cursorCanvas.setAttribute('data-layer', 'cursor');
    Object.assign(this.cursorCanvas.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '2',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    this.overlayLayer = document.createElement('div');
    this.overlayLayer.className = 'quanta-overlay-layer';
    this.overlayLayer.setAttribute('data-layer', 'overlay');
    Object.assign(this.overlayLayer.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '3',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    ctx.container.appendChild(this.cellCanvas);
    ctx.container.appendChild(this.cursorCanvas);
    ctx.container.appendChild(this.overlayLayer);

    // jsdom returns null from getContext('2d'); swallow the "Not implemented"
    // warning so test stderr stays legible.
    try {
      this.cellCtx = this.cellCanvas.getContext('2d');
      this.cursorCtx = this.cursorCanvas.getContext('2d');
    } catch {
      this.cellCtx = null;
      this.cursorCtx = null;
    }
    this.atlas = new FontAtlas(this.metrics, { rasterizer: new MemoryRasterizer() });
    this.paintLog.push({ kind: 'mount' });
  }

  applyGridSnapshot(rows: readonly Row[], cursor: CursorState | null, mode: TerminalModeState): void {
    this.gridRows = rows.length;
    this.gridCols = rows[0]?.cells.length ?? 0;
    this.mode = mode;
    if (this.cellCtx && this.cellCanvas) {
      this.cellCtx.clearRect(0, 0, this.cellCanvas.width, this.cellCanvas.height);
      // A full snapshot re-rasters every row (same path as applyGridDelta
      // without the dirty-row restriction).
      this.paintRows(rows);
    }
    if (cursor) this.applyCursor(cursor);
    this.paintLog.push({ kind: 'snapshot', rows: rows.length });
  }

  applyGridDelta(rows: readonly Row[], _dirtyRows: DamageSet): void {
    if (this.cellCtx) this.paintRows(rows);
    this.paintLog.push({ kind: 'delta', rows: rows.length });
  }

  applyCursor(cursor: CursorState | null): void {
    if (this.cursorCtx && this.cursorCanvas) {
      this.cursorCtx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
      if (cursor && cursor.visible) {
        const { cellWidthPx, cellHeightPx } = this.metrics;
        this.cursorCtx.fillStyle = this.cursorCtx.fillStyle || '#ffffff';
        this.cursorCtx.fillRect(
          cursor.col * cellWidthPx,
          cursor.row * cellHeightPx,
          cellWidthPx,
          cellHeightPx,
        );
      }
    }
    this.paintLog.push({ kind: 'cursor', cursorVisible: cursor?.visible ?? false });
  }

  applyMode(mode: TerminalModeState): void {
    this.mode = mode;
    this.paintLog.push({ kind: 'mode' });
  }

  applyMetrics(metrics: CellMetrics, dpr: number): void {
    this.metrics = metrics;
    this.dpr = dpr;
    this.atlas?.invalidateAll('dpr_change');
    this.atlas?.applyMetrics(metrics);
    this.paintLog.push({ kind: 'metrics' });
  }

  requestDamageFlush(): void {
    this.paintLog.push({ kind: 'flush' });
  }

  measureText(text: string, attrsVariant: number): TextMeasurement {
    // Width via SSOT — sum the width of each grapheme cluster.
    const classified = this.classifier.classifyStr(text);
    let cells = 0;
    for (const c of classified) {
      cells += c.width === 'zero' ? 0 : c.width === 'two' ? 2 : 1;
    }
    void attrsVariant;
    return { widthPx: cells * this.metrics.cellWidthPx, cellsWide: cells };
  }

  mountOverlay(anchor: IMEOverlayAnchor, text: string): OverlayHandle {
    const handle = { id: Symbol('overlay') };
    if (this.overlayLayer) {
      const el = document.createElement('span');
      el.className = 'quanta-ime-overlay';
      el.textContent = text;
      Object.assign(el.style, {
        position: 'absolute',
        left: `${anchor.col * anchor.metrics.cellWidthCssPx}px`,
        top: `${anchor.row * anchor.metrics.cellHeightCssPx}px`,
        textDecoration: 'underline',
        pointerEvents: 'none',
      } as CSSStyleDeclaration);
      this.overlayLayer.appendChild(el);
      this.overlays.set(handle.id, { anchor, el });
    } else {
      this.overlays.set(handle.id, {
        anchor,
        el: document.createElement('span'),
      });
    }
    this.paintLog.push({ kind: 'overlay_mount' });
    return handle;
  }

  updateOverlay(handle: OverlayHandle, text: string): void {
    const entry = this.overlays.get(handle.id);
    if (!entry) return;
    entry.el.textContent = text;
    this.paintLog.push({ kind: 'overlay_update' });
  }

  unmountOverlay(handle: OverlayHandle): void {
    const entry = this.overlays.get(handle.id);
    if (!entry) return;
    entry.el.parentElement?.removeChild(entry.el);
    this.overlays.delete(handle.id);
    this.paintLog.push({ kind: 'overlay_unmount' });
  }

  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null {
    if (xCssPx < 0 || yCssPx < 0) return null;
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const row = Math.floor(yCssPx / ch);
    const col = Math.floor(xCssPx / cw);
    if (row >= this.gridRows || col >= this.gridCols) return null;
    return { row, col, hyperlinkId: null };
  }

  cellToScreen(row: number, col: number): Rect {
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    return { x: col * cw, y: row * ch, width: cw, height: ch };
  }

  unmount(): void {
    for (const { el } of this.overlays.values()) {
      el.parentElement?.removeChild(el);
    }
    this.overlays.clear();
    if (this.container) {
      if (this.cellCanvas) this.container.removeChild(this.cellCanvas);
      if (this.cursorCanvas) this.container.removeChild(this.cursorCanvas);
      if (this.overlayLayer) this.container.removeChild(this.overlayLayer);
    }
    this.cellCanvas = null;
    this.cursorCanvas = null;
    this.overlayLayer = null;
    this.cellCtx = null;
    this.cursorCtx = null;
    this.atlas = null;
    this.container = null;
    this.paintLog.push({ kind: 'unmount' });
  }

  /** @internal Test-only: the ordered record of backend operations. */
  _paintLog(): readonly PaintEvent[] {
    return this.paintLog;
  }

  /** @internal Test-only: last DPR applied. */
  _dpr(): number {
    return this.dpr;
  }

  /** @internal Test-only: last mode snapshot held. */
  _mode(): TerminalModeState {
    return this.mode;
  }

  private paintRows(rows: readonly Row[]): void {
    const ctx = this.cellCtx;
    if (!ctx) return;
    const { cellWidthPx, cellHeightPx } = this.metrics;
    for (const row of rows) {
      if (!row) continue;
      const rowIndex = rows.indexOf(row); // snapshot-order fallback
      const y = rowIndex * cellHeightPx;
      ctx.clearRect(0, y, cellWidthPx * (row.cells.length || 0), cellHeightPx);
      let x = 0;
      for (const cell of row.cells) {
        if (cell.grapheme) {
          if (ctx.fillText) ctx.fillText(cell.grapheme, x, y + this.metrics.baselineOffsetPx);
        }
        x += cellWidthPx;
      }
    }
  }
}
