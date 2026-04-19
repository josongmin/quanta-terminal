//! Curated width-override table.
//!
//! Upstream `unicode-width` is mostly correct, but terminal reality
//! diverges in a handful of places that will cause catastrophic column
//! misalignment if we trust it blindly. Each entry below documents WHY
//! it exists; if a reviewer can't immediately see the justification, the
//! entry doesn't belong here.
//!
//! # Scope of this table
//!
//! **This table is strictly per-code-point.** Emoji ZWJ sequences, regional
//! indicator flag pairs, VS15/VS16 post-modification, skin-tone modifiers,
//! and complex family clusters are resolved at the **grapheme** level in
//! [`crate::adapters::default::DefaultClassifier`]. Putting those rules
//! here would produce wrong widths for half-formed clusters streaming
//! through `vte::Perform` one code point at a time.
//!
//! # Invariants (checked by `tests/override_table.rs`)
//!
//! 1. `OVERRIDES` is sorted strictly ascending by code point.
//! 2. No duplicate code points.
//! 3. Every entry belongs to one of the documented override categories.

use crate::domain::CellWidth;

/// Category tag for every override entry. Kept alongside the override so a
/// CI test can iterate the table and confirm every entry has a documented
/// reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverrideReason {
    /// Variation selector — zero-width on its own; the effect on the
    /// preceding cluster is applied at grapheme level, not here.
    VariationSelector,
    /// Zero-width joiner. Zero-width on its own; grapheme-level ZWJ logic
    /// glues the parts into a single 2-cell cluster.
    ZeroWidthJoiner,
    /// DEC line-drawing character — always narrow (1 cell) in real
    /// terminals. `unicode-width` agrees, but we pin it here so a future
    /// upstream change cannot silently widen box-drawing.
    DecLineDrawing,
    /// East-Asian Ambiguous corner case where `unicode-width`'s default
    /// disagrees with every major terminal in both Narrow and Wide modes.
    AmbiguousException,
    /// Emoji that `unicode-width` reports as 1 cell but that every modern
    /// terminal renders as 2 cells (and whose glyphs in a 1-cell box would
    /// overlap neighbours).
    EmojiWidening,
    /// Control / formatting character that MUST be zero-width in a grid
    /// context (BOM, zero-width-space, LRM/RLM — we treat them as
    /// structurally invisible).
    FormatControl,
}

/// A single override: `(code_point, width, reason)`.
#[derive(Debug, Clone, Copy)]
pub struct Override {
    pub code_point: u32,
    pub width: CellWidth,
    pub reason: OverrideReason,
}

/// Convenience constructor, used to keep the table terse.
const fn o(cp: u32, w: CellWidth, r: OverrideReason) -> Override {
    Override {
        code_point: cp,
        width: w,
        reason: r,
    }
}

// ---------------------------------------------------------------------------
// The override table. Sorted strictly ascending by code point.
//
// Each block has a header comment explaining the category. Do not break the
// sort order when adding entries; the `tests/override_table.rs` suite fails
// on unsorted / duplicated data.
// ---------------------------------------------------------------------------
/// Curated overrides applied on top of the upstream `unicode-width` table.
///
/// See [`crate::adapters::default::DefaultClassifier::width_for_code_point`]
/// for the lookup order (override table first, then upstream).
pub const OVERRIDES: &[Override] = &[
    // -----------------------------------------------------------------------
    // Format controls. These MUST be zero-width in a grid. `unicode-width`
    // already reports 0 for most, but we pin the common terminal-facing
    // ones explicitly so a future upstream regression can't silently break
    // column math.
    //
    // U+200B ZERO-WIDTH SPACE: acts as a soft break point in text; in a
    //   terminal it is invisible.
    // U+200C ZERO-WIDTH NON-JOINER: shaping hint; not visible.
    // U+200D ZERO-WIDTH JOINER: see `OverrideReason::ZeroWidthJoiner`.
    //   Cluster effect is applied at grapheme level.
    // U+200E / U+200F: LRM / RLM — bidi markers, zero-width.
    // U+FEFF BOM / ZERO-WIDTH NO-BREAK SPACE: invisible; often stripped
    //   upstream, but defensive here.
    // -----------------------------------------------------------------------
    o(0x0000_200B, CellWidth::Zero, OverrideReason::FormatControl),
    o(0x0000_200C, CellWidth::Zero, OverrideReason::FormatControl),
    o(
        0x0000_200D,
        CellWidth::Zero,
        OverrideReason::ZeroWidthJoiner,
    ),
    o(0x0000_200E, CellWidth::Zero, OverrideReason::FormatControl),
    o(0x0000_200F, CellWidth::Zero, OverrideReason::FormatControl),
    // -----------------------------------------------------------------------
    // East-Asian Ambiguous corner exceptions.
    //
    // U+2026 HORIZONTAL ELLIPSIS: ambiguous in UAX #11, but rendered 1 cell
    //   in every Apple / Windows / GNOME terminal we target. Pin narrow.
    // U+2190..U+2193 LEFT/UP/RIGHT/DOWN ARROW: ambiguous in UAX #11; pin
    //   narrow because they are the canonical TUI cursor glyphs and TUI
    //   programs assume 1-cell arrows (e.g. `ncdu`, `htop`, menu chrome).
    //   UAX #11 "Wide" would tear every one of those programs in
    //   narrow-ambiguous mode.
    // U+2500..U+257F BOX DRAWING: see dedicated block below. Not here.
    // -----------------------------------------------------------------------
    o(
        0x0000_2026,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_2190,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_2191,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_2192,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_2193,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    // -----------------------------------------------------------------------
    // DEC / Unicode line-drawing block (U+2500..U+257F).
    //
    // ADR 0015 §8: DEC line-drawing is ALWAYS 1 cell in a terminal. This
    // overrides any future "ambiguous-wide" default for these code points.
    // We pin the subset called out in the epic spec; if a missing glyph
    // causes misalignment in a compat-matrix program, we add it here + a
    // test case, not as a one-off in the renderer.
    // -----------------------------------------------------------------------
    o(0x0000_2500, CellWidth::One, OverrideReason::DecLineDrawing), // ─
    o(0x0000_2502, CellWidth::One, OverrideReason::DecLineDrawing), // │
    o(0x0000_250C, CellWidth::One, OverrideReason::DecLineDrawing), // ┌
    o(0x0000_2510, CellWidth::One, OverrideReason::DecLineDrawing), // ┐
    o(0x0000_2514, CellWidth::One, OverrideReason::DecLineDrawing), // └
    o(0x0000_2518, CellWidth::One, OverrideReason::DecLineDrawing), // ┘
    o(0x0000_251C, CellWidth::One, OverrideReason::DecLineDrawing), // ├
    o(0x0000_2524, CellWidth::One, OverrideReason::DecLineDrawing), // ┤
    o(0x0000_252C, CellWidth::One, OverrideReason::DecLineDrawing), // ┬
    o(0x0000_2534, CellWidth::One, OverrideReason::DecLineDrawing), // ┴
    o(0x0000_253C, CellWidth::One, OverrideReason::DecLineDrawing), // ┼
    // -----------------------------------------------------------------------
    // Ambiguous exceptions commonly seen in CJK-heavy TUIs.
    //
    // U+25CB WHITE CIRCLE: ambiguous; pin narrow (bullet glyph in menus).
    // U+25CF BLACK CIRCLE: ambiguous; pin narrow.
    // U+2605/U+2606 BLACK/WHITE STAR: ambiguous; pin narrow — selector
    //   glyphs in fzf-style UIs expect 1 cell.
    // -----------------------------------------------------------------------
    o(
        0x0000_25CB,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_25CF,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(0x0000_2600, CellWidth::Two, OverrideReason::EmojiWidening),
    o(0x0000_2601, CellWidth::Two, OverrideReason::EmojiWidening),
    o(0x0000_2602, CellWidth::Two, OverrideReason::EmojiWidening),
    o(0x0000_2603, CellWidth::Two, OverrideReason::EmojiWidening),
    o(
        0x0000_2605,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    o(
        0x0000_2606,
        CellWidth::One,
        OverrideReason::AmbiguousException,
    ),
    // U+2728 SPARKLES — terminals render at 2 cells; `unicode-width`
    // reports 1 without VS16. Pin wide to match TS mirror + user expectation.
    o(0x0000_2728, CellWidth::Two, OverrideReason::EmojiWidening),
    // -----------------------------------------------------------------------
    // Variation selectors (U+FE00..U+FE0F).
    //
    // On their own, zero-width. The cluster effect — VS15 forces
    // text-presentation (1 cell) on the preceding emoji, VS16 forces
    // emoji-presentation (2 cells) — is applied at grapheme level in
    // `DefaultClassifier::classify_grapheme`. We pin the per-code-point
    // width to zero so a lookup that happens to hit VS on its own cannot
    // return a non-zero (wrong) width.
    // -----------------------------------------------------------------------
    o(
        0x0000_FE00,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE01,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE02,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE03,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE04,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE05,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE06,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE07,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE08,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE09,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE0A,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE0B,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE0C,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE0D,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ),
    o(
        0x0000_FE0E,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ), // VS15 — text presentation
    o(
        0x0000_FE0F,
        CellWidth::Zero,
        OverrideReason::VariationSelector,
    ), // VS16 — emoji presentation
    // -----------------------------------------------------------------------
    // Format control at U+FEFF.
    //
    // BOM / ZERO-WIDTH NO-BREAK SPACE. Invisible in a terminal grid.
    // -----------------------------------------------------------------------
    o(0x0000_FEFF, CellWidth::Zero, OverrideReason::FormatControl),
    // -----------------------------------------------------------------------
    // High-plane emoji widening (U+1Fxxx).
    //
    // `unicode-width` returns 1 for a handful of "tool" / "symbol" emoji in
    // the U+1F5xx range without VS16. Real terminals render these as 2
    // cells and the TS mirror's base-width-table agrees. Pin them here so
    // Rust ↔ TS parity holds on the grapheme corpus.
    // -----------------------------------------------------------------------
    o(0x0001_F58C, CellWidth::Two, OverrideReason::EmojiWidening),
];

/// Binary-search the override table. `O(log n)` on a `const` slice —
/// compiler inlines the bounds.
#[must_use]
pub fn lookup(cp: u32) -> Option<Override> {
    OVERRIDES
        .binary_search_by_key(&cp, |e| e.code_point)
        .ok()
        .map(|i| OVERRIDES[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sorted_strictly_ascending() {
        for window in OVERRIDES.windows(2) {
            assert!(
                window[0].code_point < window[1].code_point,
                "OVERRIDES out of order at U+{:04X} / U+{:04X}",
                window[0].code_point,
                window[1].code_point,
            );
        }
    }

    #[test]
    fn table_has_no_duplicates() {
        for window in OVERRIDES.windows(2) {
            assert_ne!(window[0].code_point, window[1].code_point);
        }
    }

    #[test]
    fn lookup_finds_known_entries() {
        // VS15 / VS16
        assert_eq!(lookup(0xFE0E).map(|o| o.width), Some(CellWidth::Zero));
        assert_eq!(lookup(0xFE0F).map(|o| o.width), Some(CellWidth::Zero));
        // DEC line drawing
        assert_eq!(lookup(0x2500).map(|o| o.width), Some(CellWidth::One));
        // ZWJ
        assert_eq!(lookup(0x200D).map(|o| o.width), Some(CellWidth::Zero));
    }

    #[test]
    fn lookup_misses_unlisted() {
        assert!(lookup(0x41).is_none()); // 'A'
        assert!(lookup(0xAC00).is_none()); // '가'
    }
}
