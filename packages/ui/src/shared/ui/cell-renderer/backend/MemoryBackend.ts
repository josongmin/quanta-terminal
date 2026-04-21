/**
 * MemoryBackend — `BackendContract` implementation that records calls
 * without painting.
 *
 * Used by:
 *   - The parity suite (`backend-contract.test.ts`) — proves the contract
 *     boundary.
 *   - Regression triage (`data-renderer="memory"` flag in EPIC-H's diff
 *     harness).
 *   - Performance fixtures — a zero-paint baseline to separate backend
 *     cost from the rest of the pipeline.
 *
 * Every method records its invocation in `calls()`. `screenToCell` /
 * `cellToScreen` / `measureText` return correct data (they don't require a
 * paint surface).
 */

import { DefaultClassifier, resolveAmbiguousPolicy } from '../../../lib/width/index.js';
import type {
  CursorState,
  Row,
  TerminalModeState,
} from '../../../lib/grid-mirror/types.js';
import type { DamageSet } from '../DamageSet.js';
import type {
  CellMetrics,
  IMEOverlayAnchor,
  OverlayHandle,
  Rect,
  ScreenHit,
} from '../types.js';
import type { SearchHighlight } from '../CellBuffer.js';
import type {
  BackendContract,
  MountContext,
  TextMeasurement,
} from './BackendContract.js';

export interface MemoryBackendCall {
  readonly kind:
    | 'mount'
    | 'unmount'
    | 'snapshot'
    | 'delta'
    | 'cursor'
    | 'mode'
    | 'metrics'
    | 'measure'
    | 'flush'
    | 'overlay_mount'
    | 'overlay_update'
    | 'overlay_unmount'
    | 'search_highlights';
  readonly payload?: unknown;
}

export class MemoryBackend implements BackendContract {
  private container: HTMLElement | null = null;
  private metrics: CellMetrics;
  private dpr = 1;
  private gridRows = 0;
  private gridCols = 0;
  private readonly classifier = new DefaultClassifier(
    resolveAmbiguousPolicy('auto', 'macos', null),
  );
  private readonly _calls: MemoryBackendCall[] = [];
  private readonly overlays = new Map<symbol, { anchor: IMEOverlayAnchor; text: string }>();
  private latestCursor: CursorState | null = null;
  private rowsHeld: readonly Row[] = [];
  private modeHeld: TerminalModeState = {};

  constructor(initial?: CellMetrics) {
    this.metrics = initial ?? {
      cellWidthPx: 8,
      cellHeightPx: 16,
      baselineOffsetPx: 12,
      cellWidthCssPx: 8,
      cellHeightCssPx: 16,
    };
  }

  mount(ctx: MountContext): void {
    this.container = ctx.container;
    this.metrics = ctx.metrics;
    this.dpr = ctx.dpr;
    this._calls.push({ kind: 'mount' });
  }

  applyGridSnapshot(rows: readonly Row[], cursor: CursorState | null, mode: TerminalModeState): void {
    this.rowsHeld = rows;
    this.latestCursor = cursor;
    this.modeHeld = mode;
    this.gridRows = rows.length;
    this.gridCols = rows[0]?.cells.length ?? 0;
    this._calls.push({ kind: 'snapshot', payload: { rows: rows.length } });
  }

  applyGridDelta(rows: readonly Row[], dirtyRows: DamageSet): void {
    // Overlay delta rows into the held snapshot so future `screenToCell`
    // reflects dimensions correctly if the caller changed them via delta.
    if (rows.length > this.gridRows) this.gridRows = rows.length;
    if (rows[0] && rows[0].cells.length > this.gridCols) this.gridCols = rows[0].cells.length;
    this._calls.push({
      kind: 'delta',
      payload: { rows: rows.length, dirty: dirtyRows.rowCount() },
    });
  }

  applyCursor(cursor: CursorState | null): void {
    this.latestCursor = cursor;
    this._calls.push({ kind: 'cursor', payload: cursor });
  }

  applyMode(mode: TerminalModeState): void {
    this.modeHeld = mode;
    this._calls.push({ kind: 'mode', payload: mode });
  }

  applyMetrics(metrics: CellMetrics, dpr: number): void {
    this.metrics = metrics;
    this.dpr = dpr;
    this._calls.push({ kind: 'metrics', payload: { metrics, dpr } });
  }

  requestDamageFlush(): void {
    this._calls.push({ kind: 'flush' });
  }

  applySearchHighlights(
    highlights: readonly SearchHighlight[],
    scrollbackTop: number,
  ): void {
    this._calls.push({
      kind: 'search_highlights',
      payload: {
        count: highlights.length,
        scrollbackTop,
        // Preserve viewport-local row math so tests can assert the
        // backend received the correct translation without pulling the
        // full highlight structure through the payload shape.
        rects: highlights.map((h) => ({
          rowId: h.rowId,
          viewportRow: h.rowId - scrollbackTop,
          startCol: h.startCol,
          endColExclusive: h.endColExclusive,
          current: h.current ?? false,
        })),
      },
    });
  }

  measureText(text: string, attrsVariant: number): TextMeasurement {
    const classified = this.classifier.classifyStr(text);
    let cells = 0;
    for (const c of classified) {
      cells += c.width === 'zero' ? 0 : c.width === 'two' ? 2 : 1;
    }
    this._calls.push({ kind: 'measure', payload: { text, attrsVariant, cells } });
    return { widthPx: cells * this.metrics.cellWidthPx, cellsWide: cells };
  }

  mountOverlay(anchor: IMEOverlayAnchor, text: string): OverlayHandle {
    const handle = { id: Symbol('mem-overlay') };
    this.overlays.set(handle.id, { anchor, text });
    this._calls.push({ kind: 'overlay_mount', payload: { anchor, text } });
    return handle;
  }

  updateOverlay(handle: OverlayHandle, text: string): void {
    const entry = this.overlays.get(handle.id);
    if (!entry) return;
    this.overlays.set(handle.id, { anchor: entry.anchor, text });
    this._calls.push({ kind: 'overlay_update', payload: { text } });
  }

  unmountOverlay(handle: OverlayHandle): void {
    if (!this.overlays.has(handle.id)) return;
    this.overlays.delete(handle.id);
    this._calls.push({ kind: 'overlay_unmount' });
  }

  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null {
    if (xCssPx < 0 || yCssPx < 0) return null;
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const row = Math.floor(yCssPx / ch);
    const col = Math.floor(xCssPx / cw);
    if (row >= this.gridRows || col >= this.gridCols) return null;
    // Width SSOT: if the resolved cell is a right-half placeholder, walk
    // back one column.
    const cell = this.rowsHeld[row]?.cells[col];
    if (cell && cell.grapheme === '' && col > 0) {
      const prev = this.rowsHeld[row]?.cells[col - 1];
      if (prev && prev.cols === 2) {
        return { row, col: col - 1, hyperlinkId: prev.hyperlink_id || null };
      }
    }
    return { row, col, hyperlinkId: cell?.hyperlink_id || null };
  }

  cellToScreen(row: number, col: number): Rect {
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const cell = this.rowsHeld[row]?.cells[col];
    const span = cell?.cols === 2 ? 2 : 1;
    return { x: col * cw, y: row * ch, width: cw * span, height: ch };
  }

  unmount(): void {
    this.overlays.clear();
    this.container = null;
    this._calls.push({ kind: 'unmount' });
  }

  /** Read the recorded call log. */
  calls(): readonly MemoryBackendCall[] {
    return this._calls;
  }

  /** Reset the call log. */
  resetCalls(): void {
    this._calls.length = 0;
  }

  /** @internal Test-only: latest cursor held. */
  _latestCursor(): CursorState | null {
    return this.latestCursor;
  }

  /** @internal Test-only: latest mode held. */
  _latestMode(): TerminalModeState {
    return this.modeHeld;
  }

  /** @internal Test-only. */
  _container(): HTMLElement | null {
    return this.container;
  }

  /** @internal Test-only. */
  _dpr(): number {
    return this.dpr;
  }
}
