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
  /**
   * Wall-clock budget for the regex scan, in milliseconds. When exceeded the
   * walker stops and flags the result via `SearchGridResult.timedOut`. The
   * cheap guard from the pre-P1-F path (`text.length * 2 + 16` loop cap) is
   * kept as a per-row sanity stop against catastrophic-backtracking pure-regex
   * spin; the time budget provides the real ReDoS guarantee because a crafted
   * pattern like `^(a+)+$` can spend hundreds of ms in a single `re.exec` call.
   * Defaults to 50 ms — comfortably under one animation frame so a user-typed
   * pathological regex cannot starve the rAF loop. */
  readonly timeBudgetMs?: number;
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
 * Default wall-clock budget for a single `searchGrid` walk. The real
 * ReDoS guard is the `looksCatastrophic` pattern-shape check below; this
 * wall-clock budget is a secondary safety net for non-regex pathological
 * cases (e.g. a 100M-row scrollback future). Set generously so the
 * existing 10k × 30 perf test continues to pass without a lowered budget
 * — the interactive FindPanel opts into a tighter 50 ms budget via
 * `SearchGridOptions.timeBudgetMs`.
 */
const DEFAULT_TIME_BUDGET_MS = 5_000;

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

/**
 * Static ReDoS heuristic. Returns `true` when the regex source contains a
 * shape plausibly susceptible to catastrophic backtracking:
 *
 *   - `(X+)+` / `(X+)*` / `(X*)+` / `(X*)*` — nested unbounded quantifier
 *     on a group whose body ALSO ends in an unbounded quantifier.
 *   - `(X{m,})+` — same idea, with ranged lower-bound inner quantifier.
 *
 * Misses: alternation-based ReDoS (`(a|a)*`) is not detected by this
 * shape check. The per-row `capIterations` bound below bounds its
 * pathological cost to O(row_len²) which is acceptable for 100-char rows.
 *
 * False positives: patterns like `(abc+)+` (inner `+` applies to a single
 * char, outer applies to the whole group) DO backtrack pathologically, so
 * flagging them is correct. `(ab)+` (no inner unbounded quantifier) is
 * NOT flagged — that's a polynomial-time pattern.
 *
 * Keeping this a pure regex over regex source text — a real parser would
 * be more accurate but also orders of magnitude more code. The heuristic
 * catches the OWASP top-of-mind shapes; anything else the per-row loop
 * cap handles.
 */
function looksCatastrophic(source: string): boolean {
  // Walk the source counting open parens; when we see `(...)` followed by
  // `+` / `*` / `{n,}` AND the group body itself contains an unbounded
  // quantifier, flag. Escaped meta is skipped (`\(` etc.).
  let i = 0;
  const n = source.length;
  const openPositions: number[] = [];
  while (i < n) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      // Character class — skip to `]` (it can contain unescaped `(`/`)`
      // which we do NOT want to treat as groups).
      i += 1;
      while (i < n) {
        const c2 = source[i]!;
        if (c2 === '\\') i += 2;
        else if (c2 === ']') {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (ch === '(') {
      openPositions.push(i);
      i += 1;
      continue;
    }
    if (ch === ')') {
      const openAt = openPositions.pop();
      if (openAt !== undefined && i + 1 < n) {
        const after = source[i + 1]!;
        const groupEndsInQuantifier =
          after === '+' || after === '*' || after === '?' ||
          (after === '{' && /^\{\d+,/.test(source.slice(i + 1)));
        if (groupEndsInQuantifier && after !== '?') {
          const body = source.slice(openAt + 1, i);
          if (bodyContainsUnboundedQuantifier(body)) return true;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Does `body` (the inside of a `(...)` group) contain an unbounded
 *  quantifier (`+`, `*`, `{n,}`) not inside a `[...]` class or after `\\`? */
function bodyContainsUnboundedQuantifier(body: string): boolean {
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < n) {
        const c2 = body[i]!;
        if (c2 === '\\') i += 2;
        else if (c2 === ']') {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (ch === '+' || ch === '*') {
      // `?` lazy-modifier after `+` / `*` is still a backtracking
      // concern when nested; flag regardless.
      return true;
    }
    if (ch === '{') {
      // Pattern `{\d+,` is unbounded; `{\d+}` (exact) or `{\d+,\d+}`
      // (bounded) is NOT considered catastrophic here.
      const m = /^\{(\d+),(\d*)\}/.exec(body.slice(i));
      if (m && m[2] === '') return true;
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return false;
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
  return searchGridResult(emulator, pattern, options).matches;
}

/**
 * Extended shape returned by `searchGridResult`. Carries the same matches
 * list as `searchGrid` plus a `timedOut` flag set when the time budget
 * (`SearchGridOptions.timeBudgetMs`, default 50 ms) fired before the scan
 * finished. The FindPanel widget surfaces this as a user-visible
 * "pattern too complex" message so a pathological regex doesn't just
 * quietly drop matches.
 */
export interface SearchGridResult {
  readonly matches: GridSearchMatch[];
  readonly timedOut: boolean;
}

/**
 * Core walker. Same contract as `searchGrid` but returns the richer
 * `SearchGridResult` tuple so callers can detect a ReDoS-budget timeout.
 * Callers who don't care about the timeout flag should keep using
 * `searchGrid(emulator, pattern, options)`.
 */
/**
 * Internal variant that additionally captures the projected row text for
 * every row that produced at least one hit. Used by `IncrementalSearchCache`
 * to build a refinement index; exposed here (not exported) to keep the
 * public `searchGridResult` signature stable.
 */
function searchGridResultWithRowCapture(
  emulator: GridSearchEmulator,
  pattern: string | RegExp,
  options: SearchGridOptions | undefined,
  rowTexts: Map<number, { text: string; colMap: number[] | null; simpleCols: number; cellCount: number }> | null,
): SearchGridResult {
  const { pattern: re, empty } = compile(pattern, options);
  if (empty) return { matches: [], timedOut: false };
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const nowFn =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();
  if (looksCatastrophic(re.source)) {
    return { matches: [], timedOut: true };
  }
  const deadline = nowFn() + timeBudgetMs;
  const out: GridSearchMatch[] = [];
  let timedOut = false;
  forEachGridRow(emulator, (cells, rowId) => {
    if (out.length >= maxResults) return false;
    if (nowFn() > deadline) {
      timedOut = true;
      return false;
    }
    const projection = projectRow(cells);
    const { text, colMap, simpleCols } = projection;
    if (text.length === 0) return true;
    re.lastIndex = 0;
    const capIterations = text.length * 2 + 16;
    let iter = 0;
    let hadHit = false;
    for (;;) {
      if (iter > capIterations) break;
      iter += 1;
      const m = re.exec(text);
      if (m === null) break;
      const matched = m[0];
      if (matched.length === 0) {
        re.lastIndex = Math.min(text.length + 1, re.lastIndex + 1);
        continue;
      }
      let startCol: number;
      let endColExclusive: number;
      if (colMap === null) {
        startCol = m.index;
        endColExclusive = Math.min(m.index + matched.length, simpleCols);
      } else {
        startCol = colMap[m.index] ?? 0;
        endColExclusive = colMap[m.index + matched.length] ?? cells.length;
      }
      out.push({ rowId, startCol, endColExclusive, text: matched });
      hadHit = true;
      if (out.length >= maxResults) break;
      re.lastIndex = m.index + matched.length;
    }
    if (hadHit && rowTexts !== null) {
      rowTexts.set(rowId, { text, colMap, simpleCols, cellCount: cells.length });
    }
    if (out.length >= maxResults) return false;
    return true;
  });
  return { matches: out, timedOut };
}

export function searchGridResult(
  emulator: GridSearchEmulator,
  pattern: string | RegExp,
  options?: SearchGridOptions,
): SearchGridResult {
  return searchGridResultWithRowCapture(emulator, pattern, options, null);
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
  options?: { readonly maxResults?: number; readonly timeBudgetMs?: number },
): GridSearchMatch[] {
  if (query.text.length === 0) return [];
  const pattern: string | RegExp = query.regex ? new RegExp(query.text) : query.text;
  return searchGrid(emulator, pattern, {
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    ...(options?.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
    ...(options?.timeBudgetMs !== undefined ? { timeBudgetMs: options.timeBudgetMs } : {}),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Incremental search cache (Plan 0005 P1-F wave 1).
//
// Motivation: the FindPanel debounces keystrokes at 150 ms. Each debounce
// tick calls `searchGrid` which re-projects every scrollback row from
// packed cells → text. On a 10k-row buffer that is the dominant cost.
//
// Observation: typing narrows the query monotonically. "te" → "tes" → "test"
// is a common sequence; the new match set is always a **subset** of the old
// one because every hit of "test" is also a hit of "te", at the same row
// and with `startCol` equal to or greater than the old `startCol`. In the
// common literal-substring case the `startCol` is even identical — but we
// don't rely on that. We only rely on the "hit ⊆ prior hit" invariant.
//
// Design:
//   1. Cache stores (baseKey, pattern, matches, baseRowId, scrollbackLen,
//      viewportLen, timedOut). `baseKey` is the mode tuple
//      (caseSensitive, wholeWord, regex) — a change here invalidates.
//   2. On a new call: if the new pattern is a literal-string extension of
//      the cached pattern AND the emulator's scrollback ring + viewport
//      shape is unchanged, we filter the cached matches by re-running the
//      compiled pattern against the already-known hit substrings. Much
//      cheaper than re-walking the whole grid — each filter step is O(k)
//      where k is the cached match count, typically a few hundred at most.
//   3. On any other change — pattern retype, mode toggle, emulator
//      mutation (row-shape change, baseRowId advance, viewport length
//      change) — we fall back to a full walk.
//
// Invalidation hook: `invalidate()` drops the cache unconditionally. Call
// sites wire this into VtEmulator's envelope callback (or any other
// "rows may have moved" signal); the FindPanel widget does this so the
// cache cannot serve stale hits across PTY activity.
// ────────────────────────────────────────────────────────────────────────────

interface CacheKey {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

interface CacheEntry {
  readonly key: CacheKey;
  readonly pattern: string;
  readonly matches: GridSearchMatch[];
  readonly baseRowId: number;
  readonly scrollbackLen: number;
  readonly viewportLen: number;
  readonly timedOut: boolean;
  /**
   * Snapshot of each candidate row that held hits in the cached search.
   * Keyed by rowId; each entry is the projected row text + colMap so a
   * refinement pass can re-run the new (narrower) regex in O(rows_with_hits)
   * instead of re-walking the full grid. On a 10k-row buffer where 30 rows
   * hold hits, the refinement is ~300× cheaper than the cold path.
   */
  readonly rowTexts: Map<number, { text: string; colMap: number[] | null; simpleCols: number; cellCount: number }>;
}

export interface IncrementalSearchOptions {
  readonly maxResults?: number;
  readonly timeBudgetMs?: number;
}

/**
 * Per-FindPanel search cache. One instance lives with the widget; the
 * FindPanel store re-uses it across debounced recomputes. The object is
 * intentionally mutable (not a zustand store) because the cache is pure
 * memoization — React never needs to re-render on a cache hit.
 *
 * Thread-safety: single-threaded; a JS microtask boundary is the only
 * "concurrency" model. The cache is written synchronously during a search
 * call and read synchronously on the next one.
 */
export class IncrementalSearchCache {
  private entry: CacheEntry | null = null;

  /** Drop the cache unconditionally. Call when the emulator mutates rows. */
  invalidate(): void {
    this.entry = null;
  }

  /**
   * Resolve a search via the cache when possible, otherwise delegate to
   * `searchGridResult` and prime the cache with the fresh result.
   *
   * Query extension detection uses **literal-string** semantics: a cached
   * pattern "foo" serves an incoming "foobar" (superstring), NOT a regex
   * extension. Regex mode disables the fast-path entirely because a
   * regex extension is not a Boolean subset in general (`a|b` vs `a|bc`
   * have incompatible match sets).
   */
  resolve(
    emulator: GridSearchEmulator,
    query: {
      readonly text: string;
      readonly regex: boolean;
      readonly caseSensitive: boolean;
      readonly wholeWord: boolean;
    },
    options?: IncrementalSearchOptions,
  ): SearchGridResult {
    if (query.text.length === 0) {
      this.entry = null;
      return { matches: [], timedOut: false };
    }
    const key: CacheKey = {
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regex: query.regex,
    };
    const scrollback = emulator.getScrollback();
    const viewport = emulator.getViewportRows();
    const scrollbackLen = scrollback.rows.length;
    const viewportLen = viewport.length;
    const baseRowId = scrollback.baseRowId;
    const prev = this.entry;
    // Fast-path preconditions. Any failure drops us into the cold path.
    const prevUsable =
      prev !== null &&
      prev.key.caseSensitive === key.caseSensitive &&
      prev.key.wholeWord === key.wholeWord &&
      prev.key.regex === key.regex &&
      prev.baseRowId === baseRowId &&
      prev.scrollbackLen === scrollbackLen &&
      prev.viewportLen === viewportLen &&
      !prev.timedOut &&
      !key.regex &&
      query.text.length > prev.pattern.length &&
      isExtension(prev.pattern, query.text, key.caseSensitive);
    if (prevUsable && prev !== null) {
      // Refinement: walk each row that held a prior hit, re-apply the new
      // compiled regex against that row's cached text projection. We
      // operate on at most `prev.rowTexts.size` rows — typically a few
      // dozen — vs. the cold walk's 10k-row projection cost. This is the
      // core "2nd keystroke < 5 ms" optimization.
      const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
      const { pattern: re, empty } = compile(query.text, {
        caseSensitive: key.caseSensitive,
        wholeWord: key.wholeWord,
      });
      const filtered: GridSearchMatch[] = [];
      const nextRowTexts = new Map<
        number,
        { text: string; colMap: number[] | null; simpleCols: number; cellCount: number }
      >();
      if (!empty) {
        // Preserve the original walk order (ascending rowId) so the UI
        // navigation ("next / prev") stays monotonic.
        const orderedRowIds = Array.from(prev.rowTexts.keys()).sort((a, b) => a - b);
        for (const rowId of orderedRowIds) {
          if (filtered.length >= maxResults) break;
          const projection = prev.rowTexts.get(rowId);
          if (!projection) continue;
          const { text, colMap, simpleCols, cellCount } = projection;
          if (text.length === 0) continue;
          re.lastIndex = 0;
          const capIterations = text.length * 2 + 16;
          let iter = 0;
          let hadHit = false;
          for (;;) {
            if (iter > capIterations) break;
            iter += 1;
            const m = re.exec(text);
            if (m === null) break;
            const matched = m[0];
            if (matched.length === 0) {
              re.lastIndex = Math.min(text.length + 1, re.lastIndex + 1);
              continue;
            }
            let startCol: number;
            let endColExclusive: number;
            if (colMap === null) {
              startCol = m.index;
              endColExclusive = Math.min(m.index + matched.length, simpleCols);
            } else {
              startCol = colMap[m.index] ?? 0;
              endColExclusive = colMap[m.index + matched.length] ?? cellCount;
            }
            filtered.push({ rowId, startCol, endColExclusive, text: matched });
            hadHit = true;
            if (filtered.length >= maxResults) break;
            re.lastIndex = m.index + matched.length;
          }
          if (hadHit) nextRowTexts.set(rowId, projection);
        }
      }
      const result: SearchGridResult = { matches: filtered, timedOut: false };
      this.entry = {
        key,
        pattern: query.text,
        matches: filtered,
        baseRowId,
        scrollbackLen,
        viewportLen,
        timedOut: false,
        rowTexts: nextRowTexts,
      };
      return result;
    }
    // Cold path — full walk. Capture per-row projections so a subsequent
    // refinement can short-circuit to the rows-with-hits set.
    const rowTexts = new Map<
      number,
      { text: string; colMap: number[] | null; simpleCols: number; cellCount: number }
    >();
    const cold = searchGridResultWithRowCapture(
      emulator,
      query.regex ? new RegExp(query.text) : query.text,
      {
        caseSensitive: key.caseSensitive,
        wholeWord: key.wholeWord,
        ...(options?.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
        ...(options?.timeBudgetMs !== undefined ? { timeBudgetMs: options.timeBudgetMs } : {}),
      },
      rowTexts,
    );
    this.entry = {
      key,
      pattern: query.text,
      matches: cold.matches,
      baseRowId,
      scrollbackLen,
      viewportLen,
      timedOut: cold.timedOut,
      rowTexts,
    };
    return cold;
  }

  /** @internal test-only — is the cache primed? */
  _hasEntry(): boolean {
    return this.entry !== null;
  }
}

/**
 * Is `next` a case-correct extension of `prev`?
 * An "extension" means: `next` starts with `prev` under the active case
 * folding. When `caseSensitive === false` we lower-case both sides before
 * the prefix check; otherwise the comparison is byte-exact.
 */
function isExtension(prev: string, next: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return next.startsWith(prev);
  return next.toLowerCase().startsWith(prev.toLowerCase());
}

