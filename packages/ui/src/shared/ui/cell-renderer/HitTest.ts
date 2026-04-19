/**
 * HitTest — pixel ↔ cell conversion for selection, search highlight, and
 * pointer routing.
 *
 * Invariants (ADR 0016 §3):
 *   - `screenToCell ∘ cellToScreen` is identity within ½ cell. Property-
 *     tested on a 120×40 grid in `HitTest.test.ts`.
 *   - Wide-char right-half maps to the LEFT-HALF anchor (width SSOT rule).
 *     If a cell at (r, k) has `cols === 2`, then pixels inside the cell at
 *     (r, k+1) also return `{ row: r, col: k }`.
 *   - Out-of-grid coordinates return `null`.
 *   - x ≥ right-edge returns `col = cols` (used by Selection to mark end-of-
 *     line); negative x returns null.
 */

import type { CellBuffer } from './CellBuffer.js';
import type { CellMetrics, Rect, ScreenHit } from './types.js';

export class HitTest {
  constructor(
    private readonly buffer: CellBuffer,
    private metrics: CellMetrics,
  ) {}

  /** Update the metrics when the backend applies a DPR / font change. */
  applyMetrics(m: CellMetrics): void {
    this.metrics = m;
  }

  /**
   * Map CSS-pixel coordinates to a cell anchor.
   *
   * Returns null when the coordinates are outside the grid in either axis.
   * When x is past the last column on a valid row, returns `col: cols` —
   * callers (Selection) use this for end-of-line drag extension.
   */
  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null {
    const { rows, cols } = this.buffer.dimensions();
    if (xCssPx < 0 || yCssPx < 0) return null;
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const row = Math.floor(yCssPx / ch);
    if (row >= rows) return null;
    const rawCol = Math.floor(xCssPx / cw);
    if (rawCol >= cols) {
      return { row, col: cols, hyperlinkId: null };
    }
    // Width normalization: if the cell we landed on is the right-half of a
    // wide cluster, walk left to the anchor.
    let col = rawCol;
    const here = this.buffer.getCell(row, col);
    if (here && here.grapheme === '' && col > 0) {
      // Right-half placeholder when the preceding cell is width 2.
      const left = this.buffer.getCell(row, col - 1);
      if (left && left.cols === 2) col = col - 1;
    }
    const cell = this.buffer.getCell(row, col);
    return {
      row,
      col,
      hyperlinkId: cell?.hyperlinkId ?? null,
    };
  }

  /** Forward-map: pixel rect of a cell. Accounts for wide-char span. */
  cellToScreen(row: number, col: number): Rect {
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const cell = this.buffer.getCell(row, col);
    const spanCols = cell?.cols === 2 ? 2 : 1;
    return {
      x: col * cw,
      y: row * ch,
      width: cw * spanCols,
      height: ch,
    };
  }
}
