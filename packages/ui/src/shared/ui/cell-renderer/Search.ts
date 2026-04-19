/**
 * Search — substring + regex matching over a wrap-aware logical text view.
 *
 * ADR 0016 §7:
 *   - query is a plain string by default; `regex: true` interprets it as a
 *     JS `RegExp` source.
 *   - matches cross continuation rows (logical view joins them without
 *     separator).
 *   - Cmd+G / Ctrl+G cycle through matches with viewport-scrolling.
 *
 * The logical view keeps an anchor map: `anchorAt(offset)` returns the
 * `{row, col}` pair at a given offset into the joined string. That lets
 * search emit `SelectionAnchor` pairs without any knowledge of the paint
 * surface.
 *
 * Design: the logical view is lazily rebuilt on each `find` call (or
 * on-demand after a mirror change). The builder is O(rows × cols) so it
 * stays inside the perf budget for 120×40 grids + typical scrollback.
 * For scrollback > 100k rows, we reserve the option of a Rust-side
 * regex engine (ADR 0016 §Open → Accepted defers).
 */

import type { CellBuffer } from './CellBuffer.js';
import type {
  SearchMatch,
  SearchOptions,
  SelectionAnchor,
} from './types.js';

export class SearchError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SearchError';
  }
}

interface LogicalView {
  /** Concatenated text; continuation rows join without a separator. */
  readonly text: string;
  /** Anchor lookup from offset. */
  readonly anchorAt: (offset: number) => SelectionAnchor;
  /** Inverse: given an anchor, return its logical offset. */
  readonly offsetOf: (anchor: SelectionAnchor) => number;
}

export class Search {
  private view: LogicalView | null = null;
  private matches: SearchMatch[] = [];
  private cursor = 0;

  constructor(private readonly buffer: CellBuffer) {}

  /** Re-derive the logical view. Expose for tests; normally called implicitly. */
  buildLogicalView(): LogicalView {
    const { rows, cols } = this.buffer.dimensions();
    let text = '';
    // Array of { logicalStart, row, offsets[col] → offsetIntoText } entries.
    const rowStarts: number[] = [];
    const rowColOffsets: number[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const isContinuation = this.buffer.isContinuation(r);
      if (r > 0 && !isContinuation) text += '\n';
      rowStarts.push(text.length);
      const colOffsets: number[] = [];
      let c = 0;
      while (c < cols) {
        colOffsets[c] = text.length;
        const cell = this.buffer.getCell(r, c);
        if (!cell) {
          colOffsets[c] = text.length;
          c += 1;
          continue;
        }
        if (cell.grapheme) text += cell.grapheme;
        const span = cell.cols === 2 ? 2 : 1;
        // Right-half placeholder maps to the same offset.
        if (span === 2) colOffsets[c + 1] = text.length;
        c += span;
      }
      // Column past end → offset at text.length.
      colOffsets[cols] = text.length;
      rowColOffsets.push(colOffsets);
    }
    const view: LogicalView = {
      text,
      anchorAt: (offset: number): SelectionAnchor => {
        if (offset <= 0) return { row: 0, col: 0 };
        // Binary search for the row whose start <= offset < next-start.
        let lo = 0;
        let hi = rowStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1;
          if ((rowStarts[mid] ?? 0) <= offset) lo = mid;
          else hi = mid - 1;
        }
        const row = lo;
        // Walk the column-offset table.
        const offsets = rowColOffsets[row] ?? [];
        for (let c = 0; c < offsets.length; c += 1) {
          const here = offsets[c] ?? 0;
          const next = offsets[c + 1] ?? text.length;
          if (offset >= here && offset < next) return { row, col: c };
        }
        return { row, col: cols };
      },
      offsetOf: (anchor: SelectionAnchor): number => {
        const offsets = rowColOffsets[anchor.row] ?? [];
        return offsets[anchor.col] ?? text.length;
      },
    };
    this.view = view;
    return view;
  }

  /** Find all matches. Returns [] for empty query. */
  find(opts: SearchOptions): SearchMatch[] {
    if (!opts.query) {
      this.matches = [];
      this.cursor = 0;
      return this.matches;
    }
    const view = this.buildLogicalView();
    const matches: SearchMatch[] = [];
    if (opts.regex) {
      let re: RegExp;
      try {
        re = new RegExp(opts.query, opts.caseSensitive ? 'g' : 'gi');
      } catch (err) {
        throw new SearchError(`invalid regex: ${String(err)}`, err);
      }
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(view.text)) !== null) {
        if (m[0].length === 0) {
          // Zero-width match — advance lastIndex to avoid an infinite loop.
          re.lastIndex = re.lastIndex + 1;
          continue;
        }
        matches.push(this.matchAt(view, m.index, m[0]));
        guard += 1;
        if (guard > 100_000) break;
      }
    } else {
      const haystack = opts.caseSensitive ? view.text : view.text.toLowerCase();
      const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
      if (!needle) return [];
      let idx = 0;
      while (idx <= haystack.length - needle.length) {
        const found = haystack.indexOf(needle, idx);
        if (found === -1) break;
        matches.push(this.matchAt(view, found, view.text.slice(found, found + needle.length)));
        idx = found + Math.max(1, needle.length);
      }
    }
    this.matches = matches;
    this.cursor = 0;
    return matches;
  }

  /** Cycle to the next match. Returns the newly-active index (or -1 if empty). */
  next(): number {
    if (this.matches.length === 0) return -1;
    this.cursor = (this.cursor + 1) % this.matches.length;
    return this.cursor;
  }

  /** Cycle to the previous match. */
  prev(): number {
    if (this.matches.length === 0) return -1;
    this.cursor = (this.cursor - 1 + this.matches.length) % this.matches.length;
    return this.cursor;
  }

  /** Return the currently-active match (or null). */
  active(): SearchMatch | null {
    return this.matches[this.cursor] ?? null;
  }

  /** Clear the search state. */
  clear(): void {
    this.matches = [];
    this.cursor = 0;
  }

  /** Expose all matches. */
  all(): SearchMatch[] {
    return this.matches;
  }

  /** Return the logical view (builds on demand). */
  view_(): LogicalView {
    return this.view ?? this.buildLogicalView();
  }

  private matchAt(view: LogicalView, offset: number, matched: string): SearchMatch {
    const start = view.anchorAt(offset);
    const end = view.anchorAt(offset + matched.length);
    return {
      anchors: { start, end },
      logicalOffset: offset,
      length: Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(matched))
        .length,
    };
  }
}
