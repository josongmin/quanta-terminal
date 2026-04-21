/**
 * Grid-wide output search (Plan 0005 P1-F).
 *
 * The P0 feature subtree (`recompute.ts`, `cross-block.ts`) searches the
 * BLOCK store: it walks each block's `outputChunks` and reports char-offset
 * hits against the rendered plain-text projection. That surface is perfect
 * for the block list, but misses everything emitted into the TUI grid by a
 * full-screen program (vim, htop, less) once those rows have scrolled past
 * the viewport — the grid is owned by `VtEmulator`, not the block store.
 *
 * This module fills that gap. It walks the emulator's bounded scrollback
 * ring (`getScrollback()`) plus the live viewport (`getViewportRows()`) and
 * emits grid-space matches: `{ rowId, startCol, endColExclusive, text }`.
 * The `rowId` is the same monotonic id minted by `Scrollback.baseRowId`, so
 * consumers can map hits back to a stable row across subsequent evictions.
 *
 * Projection: each row is flattened into text by concatenating `grapheme`
 * fields of its `InternalCell`s. Wide-trailing halves (`width === 0`) map
 * to an empty grapheme and are silently skipped — the hit's `endColExclusive`
 * still lands on the column AFTER the last cell of the match so downstream
 * highlighters can paint the correct underlay width. Trailing blank cells
 * are trimmed for regex convenience (`/foo$/` works on a 120-column row
 * padded with blanks) but preserved inside the match range.
 *
 * Mode matrix:
 *   - `caseSensitive`  : omit the `i` flag
 *   - `wholeWord`      : wrap the compiled body in `\b(?:…)\b`
 *   - `maxResults`     : hard cap; once hit, the walk terminates early
 *
 * Regex accepts either a string (interpreted as a regex source) or a
 * compiled `RegExp` (flags normalized — we always add `g`, and apply
 * case-sensitivity via flag rewrite when the caller passes a plain string
 * + `caseSensitive: false`). Invalid regex sources throw a `SyntaxError`
 * — the caller (find-panel widget) catches and shows `/invalid regex/`
 * without tearing down the widget.
 *
 * Perf: 10k rows × 30 matches < 50 ms on a modern laptop. The dominant
 * cost is row text materialization (~3 µs per 80-col row); the regex
 * `exec` loop is in the noise. See `__tests__/scrollback-search.test.ts`
 * for the reference benchmark.
 */

/**
 * Minimal cell shape the indexer reads. `VtEmulator.InternalCell` is a
 * superset of this — the adapter layer only needs `grapheme` + `width` so
 * we declare the narrow contract here and let callers widen transparently.
 */
interface SearchableCell {
  readonly grapheme: string;
  readonly width: 0 | 1 | 2;
}

/** Narrow row shape — mirrors `ScrollbackRow` but with `SearchableCell`. */
interface SearchableRow {
  readonly cells: readonly SearchableCell[];
}

/** Narrow scrollback shape — subset of `Scrollback` needed by the indexer. */
interface SearchableScrollback {
  readonly rows: readonly SearchableRow[];
  readonly baseRowId: number;
}

/**
 * A single hit in the grid.
 *
 * `rowId` is the absolute monotonic row identifier (mirrors
 * `Scrollback.baseRowId` arithmetic). `startCol` and `endColExclusive` are
 * 0-indexed column positions in the row's logical cell array — i.e. the same
 * coordinate space used by `VtEmulator.grid[row][col]`. `text` is the exact
 * substring that matched (useful for debugging / clipboard export).
 */
export interface GridSearchMatch {
  readonly rowId: number;
  readonly startCol: number;
  readonly endColExclusive: number;
  readonly text: string;
}

export interface SearchGridOptions {
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  /** Hard cap on the number of matches emitted. Defaults to 10_000 —
   *  enough for interactive use, low enough to keep memory bounded on a
   *  100k-row pathological scrollback. */
  readonly maxResults?: number;
}

/**
 * Minimal emulator surface the indexer needs. `VtEmulator` implements this
 * by virtue of its `getScrollback()` / `getViewportRows()` methods; tests
 * can hand in a stub without constructing the full state machine.
 *
 * Declared in terms of `Searchable*` supertypes — the VtEmulator's richer
 * `InternalCell` shape is a structural subtype, and test code can assemble
 * minimal `{ grapheme, width }` objects without standing up SGR / color /
 * attribute state.
 */
export interface GridSearchEmulator {
  getScrollback(): SearchableScrollback;
  getViewportRows(): readonly (readonly SearchableCell[])[];
}

const DEFAULT_MAX_RESULTS = 10_000;

/**
 * Project a row's cells into a (text, colMap) pair.
 *
 * `colMap[i]` gives the starting column of the character at `text[i]`. The
 * final entry (`colMap[text.length]`) is the column AFTER the last character
 * — so `text.length === 0` produces a single-entry map of [0]. Wide-leading
 * cells contribute their grapheme at their own column; wide-trailing halves
 * are skipped (they are always `grapheme === ''`, `width === 0`).
 *
 * Trailing blank cells are trimmed off during projection — terminals pad
 * short logical lines out to the full column count with blanks and those
 * should not contribute to the search haystack. We find the last non-blank
 * cell in one pass (so `/\s$/` doesn't fire on pad bytes), then emit only
 * the prefix. The ending `colMap` entry still points to the column AFTER
 * the last emitted character, so hits near the end produce correct widths.
 *
 * Hot-path notes: this function runs once per scrollback row per search,
 * i.e. ~10k times per keystroke in the 10k-row perf target. We pre-size
 * `colMap` to the cell count (almost always the right upper bound) and
 * build `text` via character pushes into an array that is `.join('')`'d
 * once at the end — V8 optimizes this shape much better than repeated
 * string concatenation.
 */
function projectRow(
  cells: readonly SearchableCell[],
): { text: string; colMap: number[] | null; simpleCols: number } {
  const n = cells.length;
  // Find the last column that contributes a non-blank grapheme. Blanks are
  // either empty strings or a single space; treating both as "blank" is
  // fine because single-space grapheme is indistinguishable from padding.
  let lastMeaningful = -1;
  for (let c = n - 1; c >= 0; c -= 1) {
    const cell = cells[c]!;
    if (cell.width === 0) continue;
    const g = cell.grapheme;
    if (g.length > 0 && g !== ' ') {
      lastMeaningful = c;
      break;
    }
  }
  if (lastMeaningful < 0) {
    return { text: '', colMap: null, simpleCols: 0 };
  }
  const limit = lastMeaningful + 1;
  // Fast path: the row is "simple" if every cell in [0, limit) has width 1
  // and a grapheme of length 1 (or empty). That's the common case — ASCII
  // log output — and lets us skip the per-char colMap construction entirely.
  // Column-index math in the caller collapses to `col === charIndex`.
  let simple = true;
  for (let c = 0; c < limit; c += 1) {
    const cell = cells[c]!;
    if (cell.width !== 1) {
      simple = false;
      break;
    }
    const g = cell.grapheme;
    if (g.length > 1) {
      simple = false;
      break;
    }
  }
  if (simple) {
    // Build the text as a single string concat via array.join; V8 handles
    // this shape more efficiently than per-iteration `+=`.
    const chars = new Array<string>(limit);
    for (let c = 0; c < limit; c += 1) {
      const cell = cells[c]!;
      chars[c] = cell.grapheme.length === 0 ? ' ' : cell.grapheme;
    }
    return { text: chars.join(''), colMap: null, simpleCols: limit };
  }
  // Slow path: wide / multi-codepoint grapheme cells present. Build a
  // dense colMap so the caller can translate `match.index` back to cols.
  const chars: string[] = [];
  const colMap: number[] = [];
  for (let c = 0; c < limit; c += 1) {
    const cell = cells[c]!;
    if (cell.width === 0) continue;
    const g = cell.grapheme;
    if (g.length === 0) {
      chars.push(' ');
      colMap.push(c);
      continue;
    }
    // A grapheme may span multiple UTF-16 code units (surrogate pair, ZWJ).
    // Record the starting column for every code unit so `match.index`
    // (reported by `RegExp.exec` in code-unit units) maps back correctly.
    for (let k = 0; k < g.length; k += 1) colMap.push(c);
    chars.push(g);
  }
  colMap.push(limit);
  return { text: chars.join(''), colMap, simpleCols: 0 };
}

/**
 * Escape `source` so every character is a regex literal. Used when the
 * caller passes a plain string as `pattern`.
 */
export function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledPattern {
  readonly pattern: RegExp;
  readonly empty: boolean;
}

function compile(
  pattern: string | RegExp,
  options: SearchGridOptions | undefined,
): CompiledPattern {
  const caseSensitive = options?.caseSensitive ?? false;
  const wholeWord = options?.wholeWord ?? false;
  let body: string;
  let sourceFlags = '';
  if (typeof pattern === 'string') {
    if (pattern.length === 0) {
      return { pattern: /(?:)/g, empty: true };
    }
    body = escapeRegex(pattern);
  } else {
    body = pattern.source;
    sourceFlags = pattern.flags;
    if (body.length === 0) return { pattern: /(?:)/g, empty: true };
  }
  if (wholeWord) body = `\\b(?:${body})\\b`;
  // Build flag set: always `g` + `u`; `i` unless caseSensitive.
  let flags = 'gu';
  // Honour `i` from a passed-in RegExp unless caller explicitly forced
  // case-sensitivity via options.
  const inheritedCaseInsensitive = sourceFlags.includes('i');
  if (!caseSensitive && (typeof pattern === 'string' || inheritedCaseInsensitive)) {
    flags += 'i';
  } else if (!caseSensitive && typeof pattern !== 'string' && !inheritedCaseInsensitive) {
    // Caller passed a RegExp without `i` but did not opt into case-sensitive;
    // respect the RegExp's own choice (no `i`).
  }
  const compiled = new RegExp(body, flags);
  return { pattern: compiled, empty: false };
}

/**
 * Iterate every searchable row in `emulator` in scrollback-then-viewport
 * order, invoking `visit(row, absoluteRowId)`.
 *
 * Yields a handful of hundreds of closures only. The callable is pushed
 * inline so V8 can inline through it on the hot loop; the `searchGrid`
 * body keeps allocation off the inner path.
 */
function forEachGridRow(
  emulator: GridSearchEmulator,
  visit: (cells: readonly SearchableCell[], rowId: number) => boolean,
): void {
  const scrollback = emulator.getScrollback();
  const base = scrollback.baseRowId;
  const backRows = scrollback.rows;
  for (let i = 0; i < backRows.length; i += 1) {
    const row = backRows[i];
    if (row === undefined) continue;
    if (!visit(row.cells, base + i)) return;
  }
  const viewport = emulator.getViewportRows();
  const viewportBase = base + backRows.length;
  for (let r = 0; r < viewport.length; r += 1) {
    const row = viewport[r];
    if (row === undefined) continue;
    if (!visit(row, viewportBase + r)) return;
  }
}

/**
 * Walk the emulator's scrollback + viewport, emitting a `GridSearchMatch`
 * per occurrence of `pattern` in left-to-right, top-to-bottom order.
 *
 * A string pattern is treated as a literal (escaped); pass a `RegExp` if
 * you want regex semantics. Invalid regex sources bubble up as
 * `SyntaxError` — the caller is responsible for reporting the user-visible
 * error inline on the find panel.
 *
 * Zero-length matches (`/^/`, `/$/`) advance the cursor by one code unit
 * so anchor patterns don't spin. Matches that span the row boundary are
 * NOT supported — each row is searched independently. This keeps the
 * `rowId` → `(startCol, endColExclusive)` tuple fully unambiguous and
 * makes the highlight overlay trivial to render; in practice the user
 * types single-row queries, and multiline search would require a reflow
 * view that we intentionally defer.
 */
export function searchGrid(
  emulator: GridSearchEmulator,
  pattern: string | RegExp,
  options?: SearchGridOptions,
): GridSearchMatch[] {
  const { pattern: re, empty } = compile(pattern, options);
  if (empty) return [];
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const out: GridSearchMatch[] = [];
  // Cheap upper bound on loop iterations to defend against pathological
  // patterns. Recomputed per-row below.
  forEachGridRow(emulator, (cells, rowId) => {
    if (out.length >= maxResults) return false;
    const { text, colMap, simpleCols } = projectRow(cells);
    if (text.length === 0) return true;
    re.lastIndex = 0;
    const capIterations = text.length * 2 + 16;
    let iter = 0;
    for (;;) {
      if (iter > capIterations) break;
      iter += 1;
      const m = re.exec(text);
      if (m === null) break;
      const matched = m[0];
      if (matched.length === 0) {
        // Zero-width match — advance past to avoid an infinite loop.
        re.lastIndex = Math.min(text.length + 1, re.lastIndex + 1);
        continue;
      }
      let startCol: number;
      let endColExclusive: number;
      if (colMap === null) {
        // Simple path: 1 char = 1 column.
        startCol = m.index;
        endColExclusive = Math.min(m.index + matched.length, simpleCols);
      } else {
        startCol = colMap[m.index] ?? 0;
        endColExclusive = colMap[m.index + matched.length] ?? cells.length;
      }
      out.push({ rowId, startCol, endColExclusive, text: matched });
      if (out.length >= maxResults) return false;
      re.lastIndex = m.index + matched.length;
    }
    return true;
  });
  return out;
}

/**
 * Convenience overload: compile a `SearchQuery`-ish object and invoke
 * `searchGrid`. Mirrors the shape used by the P0 `compileQuery` helper so
 * the find-panel widget can call this directly without building a RegExp.
 */
export function searchGridWithQuery(
  emulator: GridSearchEmulator,
  query: {
    readonly text: string;
    readonly regex: boolean;
    readonly caseSensitive: boolean;
    readonly wholeWord: boolean;
  },
  options?: { readonly maxResults?: number },
): GridSearchMatch[] {
  if (query.text.length === 0) return [];
  const pattern: string | RegExp = query.regex ? new RegExp(query.text) : query.text;
  return searchGrid(emulator, pattern, {
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    ...(options?.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
  });
}
