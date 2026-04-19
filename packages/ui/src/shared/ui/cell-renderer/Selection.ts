/**
 * Selection + copy normalization — ADR 0016 §1, §4, §5.
 *
 * Anchors are cell-grid coordinates. `copy()` produces a UTF-8 string per
 * ADR 0016 §5:
 *   - continuation-row rejoin (wrap-joined).
 *   - block mode: each visual row becomes its own line; short rows
 *     padded with spaces.
 *   - SGR attributes stripped.
 *   - trailing whitespace stripped unless `preserveTrailingWhitespace`.
 *   - trailing-half-cell strip (never emit the empty right-half of a wide
 *     cluster).
 *   - grapheme safety: the selection walks `cell.grapheme` and never splits
 *     on code-point boundaries.
 *
 * Retires RFC §22 #20 (selection across wrapped rows → copy joined wrong).
 */

import type { CellBuffer } from './CellBuffer.js';
import type {
  CopyOptions,
  SelectionAnchor,
  SelectionMode,
  SelectionState,
  Unsubscribe,
} from './types.js';
import { DEFAULT_COPY_OPTIONS } from './types.js';

/** Normalize a selection so start <= end (top-to-bottom, left-to-right). */
export function normalizeSelection(sel: SelectionState): SelectionState {
  const { start, end, mode } = sel;
  const rowSwap = start.row > end.row || (start.row === end.row && start.col > end.col);
  if (!rowSwap) return sel;
  return { start: end, end: start, mode };
}

/** Unicode word-break classifier used by `expandToWord`. Uses
 *  `Intl.Segmenter` with `granularity: 'word'` — matches ADR 0016 decision. */
function findWordRange(text: string, pointerCol: number): { start: number; end: number } {
  if (!text) return { start: pointerCol, end: pointerCol };
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
  let offsetIntoText = 0;
  const clampedCol = Math.min(pointerCol, text.length - 1);
  for (const piece of seg.segment(text)) {
    const start = piece.index;
    const end = piece.index + piece.segment.length;
    if (clampedCol >= start && clampedCol < end) {
      return { start, end };
    }
    offsetIntoText = end;
  }
  return { start: offsetIntoText, end: offsetIntoText };
}

/** Join continuation rows (ADR 0016 §5 wrap-joined) returning a single string
 *  mapping to a row plus a column range. */
function cellsToString(buffer: CellBuffer, row: number, col0: number, col1: number): string {
  if (col1 <= col0) return '';
  let out = '';
  let c = col0;
  while (c < col1) {
    const cell = buffer.getCell(row, c);
    if (!cell) break;
    if (cell.grapheme) out += cell.grapheme;
    // Advance by the visual width of the cluster.
    c += cell.cols === 2 ? 2 : 1;
  }
  return out;
}

/** Number of cells on `row`. Uses the buffer's width-SSOT dimensions. */
function rowWidth(buffer: CellBuffer): number {
  return buffer.dimensions().cols;
}

/** Strip the right-half placeholder cell at the tail end of a run. */
function rightEdgeCol(buffer: CellBuffer, row: number, col: number): number {
  if (col <= 0) return col;
  const cell = buffer.getCell(row, col - 1);
  if (cell && cell.grapheme === '' && col - 2 >= 0) {
    const prev = buffer.getCell(row, col - 2);
    if (prev && prev.cols === 2) return col - 1;
  }
  return col;
}

/** Apply tab-stop conversion to a single line. */
function applyTabs(s: string, tabStops: number | null): string {
  if (tabStops === null) return s;
  if (tabStops <= 0) return s.replace(/\t/g, '');
  let col = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const pad = tabStops - (col % tabStops);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

export type SelectionListener = (sel: SelectionState | null) => void;

export class SelectionManager {
  private current: SelectionState | null = null;
  private listeners: SelectionListener[] = [];

  constructor(private readonly buffer: CellBuffer) {}

  /** Snapshot of the current selection (unnormalized). */
  get(): SelectionState | null {
    return this.current;
  }

  /** Normalized form — start before end in reading order. */
  normalized(): SelectionState | null {
    return this.current ? normalizeSelection(this.current) : null;
  }

  /** Begin a new selection at `anchor`, with the given mode. */
  begin(anchor: SelectionAnchor, mode: SelectionMode): void {
    let next: SelectionState = { start: anchor, end: anchor, mode };
    if (mode === 'word') next = this.expandToWord(anchor);
    else if (mode === 'line') next = this.expandToLine(anchor);
    this.current = next;
    this.emit();
  }

  /** Extend the selection's `end` to the given anchor. Mode is preserved. */
  extend(anchor: SelectionAnchor): void {
    if (!this.current) {
      this.current = { start: anchor, end: anchor, mode: 'char' };
    } else {
      this.current = { ...this.current, end: anchor };
    }
    this.emit();
  }

  /** Replace the entire selection (used by Search → SelectionAnchor reuse). */
  set(sel: SelectionState | null): void {
    this.current = sel;
    this.emit();
  }

  /** Cancel the in-progress selection. */
  cancel(): void {
    this.current = null;
    this.emit();
  }

  /** Set/unset block mode — toggled while Alt (or Opt on macOS) is held. */
  setBlockMode(blockMode: boolean): void {
    if (!this.current) return;
    const next: SelectionState = {
      ...this.current,
      mode: blockMode ? 'block' : this.current.mode === 'block' ? 'char' : this.current.mode,
    };
    this.current = next;
    this.emit();
  }

  /** Compute the word-mode range for a cell anchor. */
  expandToWord(anchor: SelectionAnchor): SelectionState {
    const row = anchor.row;
    const full = this.rowText(row);
    if (!full) return { start: anchor, end: anchor, mode: 'word' };
    const { start, end } = findWordRange(full, anchor.col);
    return {
      start: { row, col: start },
      end: { row, col: end },
      mode: 'word',
    };
  }

  /** Line-mode range — includes continuation-joined rows. */
  expandToLine(anchor: SelectionAnchor): SelectionState {
    const { rows, cols } = this.buffer.dimensions();
    let startRow = anchor.row;
    // Walk up while the current row is a continuation of something above.
    while (startRow > 0 && this.buffer.isContinuation(startRow)) startRow -= 1;
    let endRow = anchor.row;
    // Walk down while the next row is a continuation.
    while (endRow + 1 < rows && this.buffer.isContinuation(endRow + 1)) endRow += 1;
    return {
      start: { row: startRow, col: 0 },
      end: { row: endRow, col: cols },
      mode: 'line',
    };
  }

  /** Subscribe to selection changes. Returns an unsubscribe thunk. */
  onSelectionChange(cb: SelectionListener): Unsubscribe {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== cb);
    };
  }

  /**
   * Render the current selection to a UTF-8 string per ADR 0016 §5.
   * Returns the empty string for `null` / empty selections.
   */
  copy(options: CopyOptions = DEFAULT_COPY_OPTIONS): string {
    const sel = this.normalized();
    if (!sel) return '';
    if (sel.start.row === sel.end.row && sel.start.col === sel.end.col) return '';

    if (sel.mode === 'block') return this.copyBlock(sel, options);

    const { start, end } = sel;
    const cols = rowWidth(this.buffer);
    const lines: string[] = [];

    if (start.row === end.row) {
      const endCol = rightEdgeCol(this.buffer, start.row, end.col);
      lines.push(cellsToString(this.buffer, start.row, start.col, endCol));
    } else {
      // First row: start.col .. cols
      lines.push(cellsToString(this.buffer, start.row, start.col, cols));
      for (let r = start.row + 1; r < end.row; r += 1) {
        lines.push(cellsToString(this.buffer, r, 0, cols));
      }
      const endCol = rightEdgeCol(this.buffer, end.row, end.col);
      lines.push(cellsToString(this.buffer, end.row, 0, endCol));
    }

    // Wrap-aware join: a line whose NEXT row is `continuation: true` is
    // joined to the next with no separator (soft wrap). Otherwise `\n`.
    // The pieces[i] corresponds to row (start.row + i).
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const piece = lines[i] ?? '';
      const row = start.row + i;
      // Apply trailing whitespace rule per row.
      let normalized = options.preserveTrailingWhitespace ? piece : piece.replace(/\s+$/u, '');
      normalized = applyTabs(normalized, options.tabStops);
      parts.push(normalized);
      if (i < lines.length - 1) {
        const nextRow = row + 1;
        const nextIsContinuation = this.buffer.isContinuation(nextRow);
        parts.push(nextIsContinuation ? '' : '\n');
      }
    }
    return parts.join('');
  }

  private copyBlock(sel: SelectionState, options: CopyOptions): string {
    const { start, end } = sel;
    const top = Math.min(start.row, end.row);
    const bottom = Math.max(start.row, end.row);
    const left = Math.min(start.col, end.col);
    const right = Math.max(start.col, end.col);
    const outLines: string[] = [];
    for (let r = top; r <= bottom; r += 1) {
      const endCol = rightEdgeCol(this.buffer, r, right);
      const piece = cellsToString(this.buffer, r, left, endCol);
      // Pad short rows with spaces (standard rectangular-copy convention).
      const visualWidth = widthOf(this.buffer, r, left, endCol);
      const padded =
        visualWidth < right - left ? piece + ' '.repeat(right - left - visualWidth) : piece;
      const normalized = options.preserveTrailingWhitespace
        ? padded
        : padded.replace(/\s+$/u, '');
      outLines.push(applyTabs(normalized, options.tabStops));
    }
    return outLines.join('\n');
  }

  /** Pull the reading-order text of one row (continuation-blind). */
  private rowText(row: number): string {
    return cellsToString(this.buffer, row, 0, rowWidth(this.buffer));
  }

  private emit(): void {
    for (const l of this.listeners) l(this.current);
  }
}

/** Visual width of the cells between col0..col1, summed via width SSOT. */
function widthOf(buffer: CellBuffer, row: number, col0: number, col1: number): number {
  let w = 0;
  let c = col0;
  while (c < col1) {
    const cell = buffer.getCell(row, c);
    if (!cell) break;
    const span = cell.cols === 2 ? 2 : 1;
    w += span;
    c += span;
  }
  return w;
}
