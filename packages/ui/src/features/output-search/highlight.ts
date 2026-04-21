/**
 * Pure helpers for the output-search highlight pipeline.
 *
 * Why this file exists (and not just ad-hoc inline code in the widget):
 *   - `findMatches` needs to be deterministic and test-covered: a typo in the
 *     offset math would silently misplace highlights in long outputs.
 *   - The rendered-plain-text projection is shared by two consumers (the
 *     BlockCard's `AnsiOutput` highlight layer AND the store's match
 *     recomputation pass). Duplicating it would let them drift.
 *
 * Unicode — we index by UTF-16 code units (the default `string` indexing in
 * JS). Surrogate pairs therefore each occupy 2 "char offsets"; a match against
 * `hello 😀` for query `😀` yields `{ charOffset: 6, length: 2 }`. The renderer
 * slices by the same unit, so the mark wraps correctly. (Proper grapheme-level
 * indexing would need `Intl.Segmenter`, which is heavyweight for the diff this
 * would fix — no visible glitch today in the block output path.)
 */

export interface Range {
  readonly start: number;
  readonly length: number;
}

/**
 * Find every case-insensitive occurrence of `query` in `text`. Empty query or
 * empty text yields an empty array. Matches do NOT overlap — after a hit, the
 * cursor advances past the match to avoid double-reporting `aa` inside `aaa`
 * at both positions 0 and 1; the idiomatic "find" behaviour users expect from
 * Chrome's Ctrl+F is non-overlapping.
 */
export function findMatches(text: string, query: string): Range[] {
  if (text.length === 0 || query.length === 0) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const out: Range[] = [];
  let cursor = 0;
  for (;;) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx < 0) break;
    out.push({ start: idx, length: lowerQuery.length });
    cursor = idx + lowerQuery.length;
  }
  return out;
}

/**
 * Intersect a set of plain-text ranges with a list of rendered spans. Returns,
 * for each span, the sub-ranges (in SPAN-LOCAL char offsets) that fall inside
 * it. Spans that contain no matches yield an empty array at their index.
 *
 * This is the shape `AnsiOutput` consumes when the caller supplies a
 * `searchHighlights` prop: one entry per span, each listing the `{ start,
 * length }` offsets (local to the span's rendered text) to wrap in `<mark>`.
 *
 * Assumes:
 *   - `spanTexts[i]` is the FINAL rendered text of span i (already passed
 *     through control-char rewriting). The concatenation of `spanTexts` is
 *     the string we searched with `findMatches` to produce `ranges`.
 *   - `ranges` is sorted ascending and non-overlapping.
 */
export function distributeRangesToSpans(
  spanTexts: readonly string[],
  ranges: readonly Range[],
): Range[][] {
  const out: Range[][] = spanTexts.map(() => []);
  if (ranges.length === 0) return out;

  let spanIndex = 0;
  let spanStart = 0;
  // Pre-compute span-end offsets; tiny arrays and O(n) on number of spans,
  // so the memo savings are dominated by the loop math below.
  const spanEnds: number[] = new Array(spanTexts.length);
  {
    let cursor = 0;
    for (let i = 0; i < spanTexts.length; i += 1) {
      cursor += spanTexts[i]!.length;
      spanEnds[i] = cursor;
    }
  }

  for (const r of ranges) {
    // Advance to the span that contains the match start.
    while (spanIndex < spanTexts.length && spanEnds[spanIndex]! <= r.start) {
      spanStart = spanEnds[spanIndex]!;
      spanIndex += 1;
    }
    if (spanIndex >= spanTexts.length) break;
    // The match may span multiple spans. Walk forward emitting clipped
    // sub-ranges until the match ends.
    const matchEnd = r.start + r.length;
    let walker = spanIndex;
    let walkerStart = spanStart;
    while (walker < spanTexts.length && walkerStart < matchEnd) {
      const walkerEnd = spanEnds[walker]!;
      const clipStart = Math.max(r.start, walkerStart);
      const clipEnd = Math.min(matchEnd, walkerEnd);
      if (clipEnd > clipStart) {
        // Convert to span-local coordinates.
        out[walker]!.push({ start: clipStart - walkerStart, length: clipEnd - clipStart });
      }
      if (matchEnd <= walkerEnd) break;
      walkerStart = walkerEnd;
      walker += 1;
    }
  }
  return out;
}
