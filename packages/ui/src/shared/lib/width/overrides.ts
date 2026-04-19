/**
 * Curated width-override table — TypeScript mirror of
 * `crates/quanta-vt-width/src/overrides.rs`.
 *
 * Upstream Unicode width data (East-Asian Width property) is mostly correct,
 * but terminal reality diverges in a handful of places that will cause
 * catastrophic column misalignment if we trust it blindly. Each entry below
 * documents WHY it exists; if a reviewer can't immediately see the
 * justification, the entry doesn't belong here.
 *
 * # Scope of this table
 *
 * **Strictly per-code-point.** Emoji ZWJ sequences, regional indicator flag
 * pairs, VS15/VS16 post-modification, skin-tone modifiers, and complex family
 * clusters are resolved at the **grapheme** level in `DefaultClassifier`. The
 * table here only corrects individual code-point widths.
 *
 * # Parity
 *
 * Every entry in this file must match the Rust side byte-for-byte under the
 * `width_corpus.txt` parity test. Adding or removing an entry without the
 * matching Rust change fails CI.
 */

import type { CellWidth } from './types.js';

/**
 * Category tag for every override entry. Kept alongside the override so a
 * test can iterate the table and confirm every entry has a documented reason.
 *
 * Mirrors Rust `OverrideReason`.
 */
export type OverrideReason =
  /** Variation selector — zero-width on its own; the cluster effect is
   *  applied at grapheme level, not here. */
  | 'VariationSelector'
  /** Zero-width joiner. Zero-width on its own; grapheme-level ZWJ logic
   *  glues the parts into a single 2-cell cluster. */
  | 'ZeroWidthJoiner'
  /** DEC line-drawing character — always narrow (1 cell) in real terminals. */
  | 'DecLineDrawing'
  /** East-Asian Ambiguous corner case where Unicode's default disagrees
   *  with every major terminal we target. */
  | 'AmbiguousException'
  /** Emoji that upstream reports as 1 cell but that every modern terminal
   *  renders as 2 cells. */
  | 'EmojiWidening'
  /** Control / formatting character that MUST be zero-width in a grid
   *  (BOM, zero-width-space, LRM/RLM — structurally invisible). */
  | 'FormatControl';

export interface Override {
  readonly codePoint: number;
  readonly width: CellWidth;
  readonly reason: OverrideReason;
}

const e = (codePoint: number, width: CellWidth, reason: OverrideReason): Override => ({
  codePoint,
  width,
  reason,
});

// ---------------------------------------------------------------------------
// The override table. Sorted strictly ascending by code point.
// Each block has a header comment explaining the category.
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// Format controls. These MUST be zero-width in a grid. Most sources already
// report 0 for these, but we pin the common terminal-facing ones explicitly
// so a future upstream regression can't silently break column math.
//
// U+200B ZERO-WIDTH SPACE: acts as a soft break point in text; invisible.
// U+200C ZERO-WIDTH NON-JOINER: shaping hint; not visible.
// U+200D ZERO-WIDTH JOINER: cluster effect applied at grapheme level.
// U+200E / U+200F: LRM / RLM — bidi markers, zero-width.
// U+FEFF BOM / ZERO-WIDTH NO-BREAK SPACE: invisible; defensive here.
// -----------------------------------------------------------------------
const FORMAT_CONTROL_ENTRIES: readonly Override[] = [
  e(0x200b, 'zero', 'FormatControl'),
  e(0x200c, 'zero', 'FormatControl'),
  e(0x200d, 'zero', 'ZeroWidthJoiner'),
  e(0x200e, 'zero', 'FormatControl'),
  e(0x200f, 'zero', 'FormatControl'),
];

// -----------------------------------------------------------------------
// East-Asian Ambiguous corner exceptions.
//
// U+2026 HORIZONTAL ELLIPSIS: ambiguous in UAX #11, rendered 1 cell in
//   every Apple / Windows / GNOME terminal we target. Pin narrow.
// U+2190..U+2193 LEFT/UP/RIGHT/DOWN ARROW: ambiguous in UAX #11; pin
//   narrow because they are the canonical TUI cursor glyphs (ncdu, htop,
//   menu chrome). "Wide" would tear every one of those programs.
// -----------------------------------------------------------------------
const AMBIGUOUS_ARROWS_ENTRIES: readonly Override[] = [
  e(0x2026, 'one', 'AmbiguousException'),
  e(0x2190, 'one', 'AmbiguousException'),
  e(0x2191, 'one', 'AmbiguousException'),
  e(0x2192, 'one', 'AmbiguousException'),
  e(0x2193, 'one', 'AmbiguousException'),
];

// -----------------------------------------------------------------------
// DEC / Unicode line-drawing block (subset of U+2500..U+257F).
//
// ADR 0015 §8: DEC line-drawing is ALWAYS 1 cell in a terminal. This
// overrides any future "ambiguous-wide" default for these code points.
// We pin the subset called out in the epic spec; missing glyphs can be
// added here + a corpus test if misalignment surfaces.
// -----------------------------------------------------------------------
const DEC_LINE_DRAWING_ENTRIES: readonly Override[] = [
  e(0x2500, 'one', 'DecLineDrawing'), // ─
  e(0x2502, 'one', 'DecLineDrawing'), // │
  e(0x250c, 'one', 'DecLineDrawing'), // ┌
  e(0x2510, 'one', 'DecLineDrawing'), // ┐
  e(0x2514, 'one', 'DecLineDrawing'), // └
  e(0x2518, 'one', 'DecLineDrawing'), // ┘
  e(0x251c, 'one', 'DecLineDrawing'), // ├
  e(0x2524, 'one', 'DecLineDrawing'), // ┤
  e(0x252c, 'one', 'DecLineDrawing'), // ┬
  e(0x2534, 'one', 'DecLineDrawing'), // ┴
  e(0x253c, 'one', 'DecLineDrawing'), // ┼
];

// -----------------------------------------------------------------------
// Ambiguous exceptions + emoji widening commonly seen in CJK-heavy TUIs.
//
// U+2600..U+2603 SUN/CLOUD/UMBRELLA/SNOWMAN: upstream reports 1 cell but
//   every modern terminal renders these emoji as 2 cells.
// U+25CB WHITE CIRCLE: ambiguous; pin narrow (bullet glyph in menus).
// U+25CF BLACK CIRCLE: ambiguous; pin narrow.
// U+2605/U+2606 BLACK/WHITE STAR: ambiguous; pin narrow — selector glyphs
//   in fzf-style UIs expect 1 cell.
// -----------------------------------------------------------------------
const AMBIGUOUS_MISC_AND_EMOJI_WIDENING_ENTRIES: readonly Override[] = [
  e(0x25cb, 'one', 'AmbiguousException'),
  e(0x25cf, 'one', 'AmbiguousException'),
  e(0x2600, 'two', 'EmojiWidening'),
  e(0x2601, 'two', 'EmojiWidening'),
  e(0x2602, 'two', 'EmojiWidening'),
  e(0x2603, 'two', 'EmojiWidening'),
  e(0x2605, 'one', 'AmbiguousException'),
  e(0x2606, 'one', 'AmbiguousException'),
  // U+2728 SPARKLES — terminals render 2 cells; keep Rust↔TS parity.
  e(0x2728, 'two', 'EmojiWidening'),
];

// -----------------------------------------------------------------------
// Variation selectors (U+FE00..U+FE0F).
//
// On their own, zero-width. The cluster effect — VS15 forces
// text-presentation (1 cell) on the preceding emoji, VS16 forces
// emoji-presentation (2 cells) — is applied at grapheme level in
// `DefaultClassifier`. We pin the per-code-point width to zero so a
// lookup that happens to hit VS on its own cannot return a non-zero width.
// -----------------------------------------------------------------------
const VARIATION_SELECTOR_ENTRIES: readonly Override[] = [
  e(0xfe00, 'zero', 'VariationSelector'),
  e(0xfe01, 'zero', 'VariationSelector'),
  e(0xfe02, 'zero', 'VariationSelector'),
  e(0xfe03, 'zero', 'VariationSelector'),
  e(0xfe04, 'zero', 'VariationSelector'),
  e(0xfe05, 'zero', 'VariationSelector'),
  e(0xfe06, 'zero', 'VariationSelector'),
  e(0xfe07, 'zero', 'VariationSelector'),
  e(0xfe08, 'zero', 'VariationSelector'),
  e(0xfe09, 'zero', 'VariationSelector'),
  e(0xfe0a, 'zero', 'VariationSelector'),
  e(0xfe0b, 'zero', 'VariationSelector'),
  e(0xfe0c, 'zero', 'VariationSelector'),
  e(0xfe0d, 'zero', 'VariationSelector'),
  e(0xfe0e, 'zero', 'VariationSelector'), // VS15 — text presentation
  e(0xfe0f, 'zero', 'VariationSelector'), // VS16 — emoji presentation
];

// -----------------------------------------------------------------------
// Format control at U+FEFF.
// BOM / ZERO-WIDTH NO-BREAK SPACE. Invisible in a terminal grid.
// -----------------------------------------------------------------------
const BOM_ENTRIES: readonly Override[] = [e(0xfeff, 'zero', 'FormatControl')];

/**
 * All overrides, concatenated in ascending code-point order. The segments
 * above are themselves sorted, so concatenation preserves order. Exposed
 * primarily for tests and diagnostics; production lookup goes through
 * `OVERRIDES_BY_CP`.
 */
export const OVERRIDES: readonly Override[] = [
  ...FORMAT_CONTROL_ENTRIES,
  ...AMBIGUOUS_ARROWS_ENTRIES,
  ...DEC_LINE_DRAWING_ENTRIES,
  ...AMBIGUOUS_MISC_AND_EMOJI_WIDENING_ENTRIES,
  ...VARIATION_SELECTOR_ENTRIES,
  ...BOM_ENTRIES,
];

/**
 * Fast lookup from code point to override entry. Built once at module load.
 */
const OVERRIDES_BY_CP: Map<number, Override> = new Map(
  OVERRIDES.map((o) => [o.codePoint, o] as const),
);

/**
 * Look up an override entry for a code point. Returns `undefined` if the
 * code point is not in the curated table.
 *
 * Mirrors Rust `overrides::lookup`.
 */
export function lookupOverride(codePoint: number): Override | undefined {
  return OVERRIDES_BY_CP.get(codePoint);
}
