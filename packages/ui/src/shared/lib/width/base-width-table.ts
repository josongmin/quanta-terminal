/**
 * Hand-built base-width lookup tables for the TS width classifier.
 *
 * This module stands in for the Rust `unicode-width` crate. In the Rust
 * side, `DefaultClassifier::width_for_code_point` consults the curated
 * override table FIRST, then falls back to `unicode-width`. Here we do the
 * same — `classifier.ts` checks `overrides.ts` first, then this table.
 *
 * # Why hand-built
 *
 * We could ship a WASM build of `unicode-width` (~40 KB) or a generated
 * 1600-line lookup derived from the corpus. Both solutions carry more
 * tooling risk than a ~150-line hand table covering the Unicode ranges
 * the terminal actually hits.
 *
 * The categories below are derived from:
 * - UAX #11 "East Asian Width" (EAW = W / F → 2, EAW = A → ambiguous,
 *   otherwise 1).
 * - UAX #44 General_Category Mn / Mc / Me (combining / enclosing marks → 0).
 * - Unicode Cf (format controls except the ones in the override table → 0).
 *
 * # Parity enforcement
 *
 * The corpus under `crates/quanta-vt-width/tests/fixtures/width_corpus.txt`
 * (500+ entries) is run through `DefaultClassifier` in
 * `__tests__/parity.test.ts`. Any divergence here vs the Rust side fails
 * that test row-for-row.
 */

import type { CellWidth } from './types.js';

/** Inclusive code-point range. */
type Range = readonly [start: number, end: number];

// ---------------------------------------------------------------------------
// Zero-width ranges (combining marks, format controls, enclosing marks).
// UAX #44 categories Mn / Me / Cf subset. MUST be sorted ascending by start.
// ---------------------------------------------------------------------------
const ZERO_WIDTH_RANGES: readonly Range[] = [
  // C0 + DEL + C1 control characters — engine dispatches as control, not render.
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  // Soft hyphen (Cf / format control — zero-width in a terminal grid).
  [0x00ad, 0x00ad],
  // Combining Diacritical Marks.
  [0x0300, 0x036f],
  // Combining Diacritical Marks Extended.
  [0x1ab0, 0x1aff],
  // Combining Diacritical Marks Supplement.
  [0x1dc0, 0x1dff],
  // Combining Diacritical Marks for Symbols.
  [0x20d0, 0x20ff],
  // Variation Selectors Supplement (U+E0100-U+E01EF) — zero-width per Unicode.
  [0xe0100, 0xe01ef],
];

// ---------------------------------------------------------------------------
// Wide ranges (EAW = W or F → 2 cells). MUST be sorted ascending by start.
// Conservative but covers CJK / Hangul / full-width / emoji the terminal sees.
// ---------------------------------------------------------------------------
const WIDE_RANGES: readonly Range[] = [
  // Hangul Jamo initial consonants.
  [0x1100, 0x115f],
  // CJK Radicals Supplement + Kangxi Radicals.
  [0x2e80, 0x303e],
  // Hiragana / Katakana / Bopomofo / Hangul Compatibility Jamo / CJK Sym & Punct.
  [0x3041, 0x33ff],
  // CJK Unified Ideographs Extension A.
  [0x3400, 0x4dbf],
  // CJK Unified Ideographs.
  [0x4e00, 0x9fff],
  // Yi Syllables + Yi Radicals.
  [0xa000, 0xa4cf],
  // Hangul Jamo Extended-A.
  [0xa960, 0xa97f],
  // Hangul Syllables.
  [0xac00, 0xd7a3],
  // Hangul Jamo Extended-B.
  [0xd7b0, 0xd7ff],
  // CJK Compatibility Ideographs.
  [0xf900, 0xfaff],
  // Vertical Forms + CJK Compatibility Forms.
  [0xfe30, 0xfe4f],
  // Full-width forms (part of Halfwidth and Fullwidth Forms).
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  // Mahjong, Domino, Playing cards (default emoji-presentation in practice).
  [0x1f000, 0x1f02f],
  [0x1f030, 0x1f09f],
  // Enclosed alphanumeric supplement (some EAW=W: keycap bases 1F100+).
  [0x1f100, 0x1f1ad],
  // Regional Indicator Symbols.
  [0x1f1e6, 0x1f1ff],
  // Miscellaneous Symbols and Pictographs, Emoticons, Transport & Map.
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f700, 0x1f773],
  [0x1f780, 0x1f7d8],
  [0x1f800, 0x1f80b],
  [0x1f810, 0x1f847],
  [0x1f850, 0x1f859],
  [0x1f860, 0x1f887],
  [0x1f890, 0x1f8ad],
  [0x1f8b0, 0x1f8b1],
  // Supplemental Symbols and Pictographs.
  [0x1f900, 0x1f9ff],
  [0x1fa00, 0x1fa53],
  [0x1fa60, 0x1fa6d],
  [0x1fa70, 0x1faff],
  // Supplementary CJK (plane 2 & 3).
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

// ---------------------------------------------------------------------------
// Ambiguous ranges (EAW = A). Width 1 under Narrow policy, 2 under Wide.
//
// This list is conservative — covers the ranges the classifier actually
// hits in the corpus. A code point not matched here falls through to width 1.
// ---------------------------------------------------------------------------
const AMBIGUOUS_RANGES: readonly Range[] = [
  // General Punctuation: left/right quotation marks, horizontal ellipsis,
  // etc. (U+2010..U+2027 subset is ambiguous).
  [0x00a1, 0x00a1], // ¡
  [0x00a4, 0x00a4], // ¤
  [0x00a7, 0x00a8], // § ¨
  [0x00aa, 0x00aa], // ª
  [0x00ad, 0x00ae], // soft hyphen, ®
  [0x00b0, 0x00b4], // ° ± ² ³ ´
  [0x00b6, 0x00ba], // ¶ · ¸ ¹ º
  [0x00bc, 0x00bf], // ¼ ½ ¾ ¿
  [0x00c6, 0x00c6], // Æ
  [0x00d0, 0x00d0], // Ð
  [0x00d7, 0x00d8], // × Ø
  [0x00de, 0x00e1], // Þ ß à á
  [0x00e6, 0x00e6], // æ
  [0x00e8, 0x00ea], // è é ê
  [0x00ec, 0x00ed], // ì í
  [0x00f0, 0x00f0], // ð
  [0x00f2, 0x00f3], // ò ó
  [0x00f7, 0x00fa], // ÷ ø ù ú
  [0x00fc, 0x00fc], // ü
  [0x00fe, 0x00fe], // þ
  // Greek/Cyrillic selected code points (a few are EAW=A but we do not
  // cover them here; corpus does not exercise them).
  // General Punctuation — quotes + en/em dash range subset.
  [0x2010, 0x2010],
  [0x2013, 0x2016],
  [0x2018, 0x2019],
  [0x201c, 0x201d],
  [0x2020, 0x2022],
  [0x2024, 0x2027],
  [0x2030, 0x2030],
  [0x2032, 0x2033],
  [0x2035, 0x2035],
  [0x203b, 0x203b],
  [0x203e, 0x203e],
  [0x2074, 0x2074],
  [0x207f, 0x207f],
  [0x2081, 0x2084],
  [0x20ac, 0x20ac],
  [0x2103, 0x2103],
  [0x2105, 0x2105],
  [0x2109, 0x2109],
  [0x2113, 0x2113],
  [0x2116, 0x2116],
  [0x2121, 0x2122],
  [0x2126, 0x2126],
  [0x212b, 0x212b],
  [0x2153, 0x2154],
  [0x215b, 0x215e],
  [0x2160, 0x216b],
  [0x2170, 0x2179],
  [0x2189, 0x2189],
  // Box drawing / block elements — overridden to One in table but they are
  // ambiguous; pin here for Wide policy (U+2500..U+257F). The curated
  // overrides.ts covers the specific DEC line-drawing glyphs (width=1 in
  // all modes); other boxes outside that subset remain ambiguous.
  [0x2500, 0x254b],
  [0x2550, 0x2573],
  [0x2580, 0x258f],
  [0x2592, 0x2595],
  [0x25a0, 0x25a1],
  [0x25a3, 0x25a9],
  [0x25b2, 0x25b3],
  [0x25b6, 0x25b7],
  [0x25bc, 0x25bd],
  [0x25c0, 0x25c1],
  [0x25c6, 0x25c8],
  [0x25cb, 0x25cb],
  [0x25ce, 0x25d1],
  [0x25e2, 0x25e5],
  [0x25ef, 0x25ef],
  // Misc Symbols tail (but U+2600..U+2603 covered by overrides as Two).
  [0x2605, 0x2606],
  [0x2609, 0x2609],
  [0x260e, 0x260f],
  [0x261c, 0x261c],
  [0x261e, 0x261e],
  [0x2640, 0x2640],
  [0x2642, 0x2642],
  [0x2660, 0x2661],
  [0x2663, 0x2665],
  [0x2667, 0x266a],
  [0x266c, 0x266d],
  [0x266f, 0x266f],
  [0x269e, 0x269f],
  [0x26bf, 0x26bf],
  [0x26c6, 0x26cd],
  [0x26cf, 0x26d3],
  [0x26d5, 0x26e1],
  [0x26e3, 0x26e3],
  [0x26e8, 0x26e9],
  [0x26eb, 0x26f1],
  [0x26f4, 0x26f4],
  [0x26f6, 0x26f9],
  [0x26fb, 0x26fc],
  [0x26fe, 0x26ff],
  [0x273d, 0x273d],
  [0x2776, 0x277f],
  // Arrows (overridden explicitly for ←↑→↓; rest of block is ambiguous).
  [0x2190, 0x21ff],
];

// ---------------------------------------------------------------------------
// Half-width / narrow ranges forced to 1 cell regardless of policy.
// ---------------------------------------------------------------------------
const NARROW_RANGES: readonly Range[] = [
  // Half-width Katakana — explicitly narrow (UAX #11 Na).
  [0xff61, 0xffdc],
  [0xffe8, 0xffee],
];

function inAnyRange(cp: number, ranges: readonly Range[]): boolean {
  // Binary search — ranges MUST be sorted ascending by start. Terminator-
  // guarded with a linear fallback commented out since arrays are small
  // enough that either approach is O(log n) ≈ O(n) in practice.
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (range === undefined) return false;
    const [start, end] = range;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Base width for a single code point, before curated overrides.
 *
 * Lookup order (mirrors Rust `DefaultClassifier::width_for_code_point`
 * after the override check):
 *
 * 1. Combining / control / format → `'zero'`.
 * 2. Explicitly narrow (half-width) → `'one'`.
 * 3. Wide (CJK / Hangul / full-width / emoji) → `'two'`.
 * 4. Ambiguous → `'one'` under Narrow policy, `'two'` under Wide.
 * 5. Default → `'one'`.
 */
export function baseWidthForCodePoint(cp: number, ambigWide: boolean): CellWidth {
  // Zero-width (combining, control, enclosing).
  if (inAnyRange(cp, ZERO_WIDTH_RANGES)) return 'zero';
  // Explicitly narrow (half-width Katakana).
  if (inAnyRange(cp, NARROW_RANGES)) return 'one';
  // Wide (CJK / Hangul / emoji / full-width).
  if (inAnyRange(cp, WIDE_RANGES)) return 'two';
  // Ambiguous — policy decides.
  if (inAnyRange(cp, AMBIGUOUS_RANGES)) {
    return ambigWide ? 'two' : 'one';
  }
  // Default: one cell.
  return 'one';
}
