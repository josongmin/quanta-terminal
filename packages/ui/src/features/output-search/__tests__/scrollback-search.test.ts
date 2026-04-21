/**
 * Unit tests for `features/output-search/scrollback-search.ts`.
 *
 * Covered:
 *   1. Empty-query / empty-emulator short-circuits.
 *   2. Literal substring match across scrollback rows.
 *   3. Literal substring match across live viewport rows.
 *   4. Combined scrollback + viewport ordering (rowIds monotonic).
 *   5. Case-sensitive toggle.
 *   6. Whole-word toggle.
 *   7. Regex pattern with capture groups.
 *   8. Regex flag preservation — `g` always forced; `i` honoured.
 *   9. Invalid regex throws SyntaxError.
 *  10. Zero-length regex match does not spin.
 *  11. `maxResults` cap stops early and preserves order.
 *  12. Wide-character / surrogate-pair cells produce correct columns.
 *  13. Trailing blanks do not create spurious `/\s$/` hits.
 *  14. `baseRowId > 0` is reflected in emitted rowIds.
 *  15. Multiple hits per row keep non-overlapping columns.
 *  16. `searchGridWithQuery` convenience wrapper works.
 *  17. Perf budget: 10k rows × 30 matches under 50 ms.
 */

import { describe, expect, it } from 'vitest';

import {
  escapeRegex as escapeRegexForGrid,
  searchGrid,
  searchGridWithQuery,
  type GridSearchEmulator,
} from '../scrollback-search.js';

type Cell = { readonly grapheme: string; readonly width: 0 | 1 | 2 };

/**
 * Build a `GridSearchEmulator` stub from string rows. Each string becomes a
 * viewport row; caller controls the split between scrollback + viewport via
 * `scrollbackLines`. The `width` field is derived: single-codepoint chars
 * are width 1; CJK full-width / emoji get width 2 + a trailing width-0 half.
 */
function makeEmulator(opts: {
  readonly scrollbackLines?: readonly string[];
  readonly viewportLines?: readonly string[];
  readonly cols?: number;
  readonly baseRowId?: number;
}): GridSearchEmulator {
  const cols = opts.cols ?? 80;
  const scrollbackLines = opts.scrollbackLines ?? [];
  const viewportLines = opts.viewportLines ?? [];
  const baseRowId = opts.baseRowId ?? 0;

  const toCells = (line: string): Cell[] => {
    const cells: Cell[] = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(line)) {
      // Rough "wide" heuristic — anything above the BMP + CJK punctuation.
      const cp = segment.codePointAt(0) ?? 0;
      const isWide =
        cp > 0xffff ||
        (cp >= 0x3000 && cp <= 0x9fff) ||
        (cp >= 0xff00 && cp <= 0xffef);
      if (isWide) {
        cells.push({ grapheme: segment, width: 2 });
        cells.push({ grapheme: '', width: 0 });
      } else {
        cells.push({ grapheme: segment, width: 1 });
      }
    }
    // Pad to cols with blanks.
    while (cells.length < cols) cells.push({ grapheme: '', width: 1 });
    return cells;
  };

  const scrollback = {
    rows: scrollbackLines.map((line) => ({ cells: toCells(line) })),
    baseRowId,
  };
  const viewport = viewportLines.map(toCells);

  return {
    getScrollback: () => scrollback,
    getViewportRows: () => viewport,
  };
}

describe('searchGrid', () => {
  it('returns [] for empty pattern (string)', () => {
    const em = makeEmulator({ viewportLines: ['hello'] });
    expect(searchGrid(em, '')).toEqual([]);
  });

  it('returns [] when no rows', () => {
    const em = makeEmulator({});
    expect(searchGrid(em, 'anything')).toEqual([]);
  });

  it('finds literal substrings in scrollback rows', () => {
    const em = makeEmulator({
      scrollbackLines: ['hello world', 'foo bar baz'],
      cols: 20,
    });
    const hits = searchGrid(em, 'bar');
    expect(hits).toEqual([
      { rowId: 1, startCol: 4, endColExclusive: 7, text: 'bar' },
    ]);
  });

  it('finds literal substrings in viewport rows', () => {
    const em = makeEmulator({
      viewportLines: ['no match here', 'hello world'],
      cols: 20,
    });
    const hits = searchGrid(em, 'world');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      rowId: 1,
      startCol: 6,
      endColExclusive: 11,
      text: 'world',
    });
  });

  it('walks scrollback then viewport in order', () => {
    const em = makeEmulator({
      scrollbackLines: ['alpha', 'beta alpha'],
      viewportLines: ['gamma alpha', 'delta'],
      cols: 20,
    });
    const hits = searchGrid(em, 'alpha');
    const rowIds = hits.map((h) => h.rowId);
    expect(rowIds).toEqual([0, 1, 2]);
  });

  it('honours case-sensitive toggle', () => {
    const em = makeEmulator({
      viewportLines: ['Hello hello HELLO'],
      cols: 30,
    });
    const insensitive = searchGrid(em, 'hello');
    expect(insensitive).toHaveLength(3);
    const sensitive = searchGrid(em, 'hello', { caseSensitive: true });
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0]!.text).toBe('hello');
  });

  it('honours whole-word toggle', () => {
    const em = makeEmulator({
      viewportLines: ['foo foobar foo-bar'],
      cols: 30,
    });
    const all = searchGrid(em, 'foo');
    expect(all.length).toBeGreaterThanOrEqual(3);
    const wholeWord = searchGrid(em, 'foo', { wholeWord: true });
    // "foo" alone + "foo" in "foo-bar" (hyphen is a word boundary).
    // "foobar" should NOT match.
    expect(wholeWord.length).toBe(2);
    for (const h of wholeWord) expect(h.text).toBe('foo');
  });

  it('accepts regex patterns with capture groups', () => {
    const em = makeEmulator({
      viewportLines: ['err 404 err 500 warn 302'],
      cols: 40,
    });
    const hits = searchGrid(em, /\d{3}/);
    expect(hits.map((h) => h.text)).toEqual(['404', '500', '302']);
  });

  it('respects RegExp flags when passed directly', () => {
    const em = makeEmulator({
      viewportLines: ['Foo foo FOO'],
      cols: 20,
    });
    // Passing a RegExp without `i` → only exact-case hits match. The
    // caller is signalling "use my flags" by constructing the regex.
    const strict = searchGrid(em, /foo/);
    expect(strict).toHaveLength(1);
    // Passing `/foo/i` → all three match.
    const relaxed = searchGrid(em, /foo/i);
    expect(relaxed).toHaveLength(3);
  });

  it('throws SyntaxError on invalid regex source', () => {
    const em = makeEmulator({ viewportLines: ['hi'] });
    expect(() => searchGrid(em, new RegExp('['))).toThrow(SyntaxError);
  });

  it('does not spin on zero-length regex matches', () => {
    const em = makeEmulator({
      viewportLines: ['abcdef'],
      cols: 10,
    });
    // /\b/ is zero-length; the indexer must advance the cursor and terminate.
    const hits = searchGrid(em, /\b/);
    // Depending on the test environment the hits list may be empty or
    // contain zero-length matches that were skipped — the non-hang property
    // is what we care about. Bound the result size as a soft assertion.
    expect(hits.length).toBeLessThan(50);
  });

  it('caps output at maxResults', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i += 1) lines.push('foo foo foo');
    const em = makeEmulator({ viewportLines: lines, cols: 20 });
    const hits = searchGrid(em, 'foo', { maxResults: 10 });
    expect(hits).toHaveLength(10);
    // Preserve ordering: first hit must be on row 0.
    expect(hits[0]!.rowId).toBe(0);
  });

  it('maps surrogate-pair grapheme columns correctly', () => {
    // Emoji 😀 occupies one "cell" but is two UTF-16 code units internally.
    // We render it as width=2 (see makeEmulator heuristic).
    const em = makeEmulator({
      viewportLines: ['a😀b find-me'],
      cols: 30,
    });
    const hits = searchGrid(em, 'find-me');
    expect(hits).toHaveLength(1);
    // Column 0 = 'a', 1+2 = emoji (wide + trailing), 3 = 'b', 4 = ' ',
    // 5 = 'find-me'.
    expect(hits[0]!.startCol).toBe(5);
  });

  it('trims trailing blanks from the search haystack', () => {
    const em = makeEmulator({
      viewportLines: ['hello'],
      cols: 80,
    });
    // Regex /end$/ against "hello" padded with 75 blanks. Without the trim
    // pass `end$` would never match. With the trim pass it still shouldn't
    // match because "hello" doesn't end with "end" — but we must not get a
    // bogus match on the trailing space block either.
    const hits = searchGrid(em, /\s$/);
    expect(hits).toEqual([]);
    // Positive control — /o$/ should hit.
    const tail = searchGrid(em, /o$/);
    expect(tail).toHaveLength(1);
  });

  it('reflects baseRowId > 0 in emitted rowIds', () => {
    const em = makeEmulator({
      scrollbackLines: ['alpha target'],
      viewportLines: ['beta target'],
      baseRowId: 1000,
      cols: 20,
    });
    const hits = searchGrid(em, 'target');
    expect(hits.map((h) => h.rowId)).toEqual([1000, 1001]);
  });

  it('finds non-overlapping hits on the same row', () => {
    const em = makeEmulator({
      viewportLines: ['aaaaaa'],
      cols: 10,
    });
    const hits = searchGrid(em, 'aa');
    // Non-overlapping: positions 0, 2, 4.
    expect(hits.map((h) => h.startCol)).toEqual([0, 2, 4]);
  });

  it('searchGridWithQuery compiles query object', () => {
    const em = makeEmulator({ viewportLines: ['Foo foo FOO'], cols: 20 });
    const hits = searchGridWithQuery(em, {
      text: 'foo',
      regex: false,
      caseSensitive: true,
      wholeWord: true,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe('foo');
  });

  it('escapeRegexForGrid neutralizes regex metacharacters', () => {
    // Sanity: confirm the exported helper escapes metas so callers that
    // bypass the compile helper can reuse the same escaping.
    expect(escapeRegexForGrid('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegexForGrid('')).toBe('');
  });

  it('perf budget: 10k scrollback rows × 30 matches under 50ms', () => {
    // Build a 10k-row scrollback where every 333rd row contains the match.
    // That yields ~30 hits but forces the walker to touch every row — the
    // real-world cost shape.
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      if (i % 333 === 0) lines.push('lorem ipsum target dolor sit amet');
      else lines.push('lorem ipsum dolor sit amet');
    }
    const em = makeEmulator({ scrollbackLines: lines, cols: 80 });
    // Warm-up run so V8 picks up the hot shapes before we time.
    searchGrid(em, 'target');
    const start =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const hits = searchGrid(em, 'target');
    const elapsed =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    expect(hits.length).toBeGreaterThan(25);
    expect(hits.length).toBeLessThan(40);
    // 50 ms budget on the indexer itself — leaves margin for the widget
    // debounce + overlay paint to land the full "< 200 ms to first paint"
    // quality bar.
    expect(elapsed).toBeLessThan(50);
  });
});
