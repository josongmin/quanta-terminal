//! Production `WidthClassifier` — wraps `unicode-segmentation` +
//! `unicode-width`, applies the curated override table, and resolves
//! cluster-level rules (VS15/VS16, ZWJ, regional indicators, skin-tone).
//!
//! **Zero panics**: all fallible paths return a sensible default. The fuzz
//! target (`fuzz/fuzz_targets/classify.rs`) pins this.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;

use crate::domain::{AmbiguousWidthPolicy, CellWidth, Grapheme, WrapEligibility};
use crate::overrides;
use crate::ports::WidthClassifier;

/// Variation Selector 15 — force text-presentation (1 cell) on the
/// preceding emoji-presentation code point.
const VS15: char = '\u{FE0E}';
/// Variation Selector 16 — force emoji-presentation (2 cells) on the
/// preceding text-presentation code point.
const VS16: char = '\u{FE0F}';
/// Zero-Width Joiner — glues multiple emoji into a single cluster.
const ZWJ: char = '\u{200D}';

/// Production classifier.
///
/// Construct via [`DefaultClassifier::new`] with an already-resolved
/// [`AmbiguousWidthPolicy`]. Callers MUST NOT pass `Auto` — resolve it
/// first via [`AmbiguousWidthPolicy::resolve`] at session boot. If `Auto`
/// slips in, the classifier treats it as `Narrow` (safest default for
/// Western terminals) but logs a `tracing::warn!` so CI catches it.
#[derive(Debug, Clone)]
pub struct DefaultClassifier {
    ambig_wide: bool,
}

impl DefaultClassifier {
    /// Build a classifier pinned to a resolved ambiguous-width policy.
    #[must_use]
    pub fn new(policy: AmbiguousWidthPolicy) -> Self {
        let ambig_wide = match policy {
            AmbiguousWidthPolicy::Wide => true,
            AmbiguousWidthPolicy::Narrow => false,
            AmbiguousWidthPolicy::Auto => {
                tracing::warn!(
                    "DefaultClassifier received AmbiguousWidthPolicy::Auto — \
                     callers should resolve() before construction; \
                     falling back to Narrow"
                );
                false
            }
        };
        Self { ambig_wide }
    }

    /// Look up a single code point's width.
    ///
    /// Lookup order:
    ///
    /// 1. Curated [`overrides::OVERRIDES`] table. If hit, that wins.
    /// 2. `unicode-width` — either `width` (narrow ambig) or `width_cjk`
    ///    (wide ambig), per the resolved policy.
    ///
    /// Control characters (`unicode-width` returns `None`) collapse to
    /// [`CellWidth::Zero`] — the VT engine is responsible for dispatching
    /// them as CSI sequences, not rendering them, so their nominal width
    /// in the grid is zero.
    fn width_for_code_point(&self, c: char) -> CellWidth {
        if let Some(o) = overrides::lookup(c as u32) {
            return o.width;
        }
        let w = if self.ambig_wide {
            UnicodeWidthChar::width_cjk(c)
        } else {
            UnicodeWidthChar::width(c)
        };
        match w {
            Some(0) => CellWidth::Zero,
            Some(1) => CellWidth::One,
            Some(2) => CellWidth::Two,
            // Either > 2 (never produced by unicode-width) or None
            // (control char). Zero-width is the safest grid default.
            _ => CellWidth::Zero,
        }
    }

    /// Cluster-level width: scans the grapheme for VS15/VS16/ZWJ and
    /// yields the final cell width.
    ///
    /// Algorithm:
    ///
    /// 1. Zero-length cluster → Zero (neutral).
    /// 2. Single code point → per-code-point width (override table first,
    ///    then `unicode-width`). This is where lone VS15/VS16/ZWJ fall
    ///    through as Zero — their cluster-widening rules ONLY apply when
    ///    there's a base character in the cluster.
    /// 3. Multi-code-point cluster:
    ///    a. If ZWJ is present, the whole cluster is 2 cells. Every ZWJ
    ///       emoji sequence in UTS #51 has emoji-presentation members;
    ///       the cluster renders as a single wide glyph.
    ///    b. If VS16 is present, force 2 cells (emoji-presentation
    ///       override, retires failure mode #7).
    ///    c. If VS15 is present, force 1 cell (text-presentation).
    ///    d. Two or more regional indicators → 2 cells (flag).
    ///    e. Otherwise: width of the FIRST non-zero-width code point
    ///       (combining marks after a base do not widen the base).
    fn cluster_width(&self, cluster: &str) -> CellWidth {
        if cluster.is_empty() {
            return CellWidth::Zero;
        }

        let mut iter = cluster.chars();
        let first = iter.next();
        let is_single = first.is_some() && iter.next().is_none();

        if is_single {
            // Lone code point — the override table's zero-widths for VS and
            // ZWJ are authoritative. Do NOT apply cluster-widening rules.
            return self.width_for_code_point(first.unwrap_or('\0'));
        }

        let mut has_zwj = false;
        let mut has_vs16 = false;
        let mut has_vs15 = false;
        let mut ri_count = 0usize;
        let mut base_width: Option<CellWidth> = None;

        for c in cluster.chars() {
            match c {
                ZWJ => has_zwj = true,
                VS15 => has_vs15 = true,
                VS16 => has_vs16 = true,
                _ => {}
            }
            if is_regional_indicator(c) {
                ri_count += 1;
            }
            if base_width.is_none() {
                let w = self.width_for_code_point(c);
                if !matches!(w, CellWidth::Zero) {
                    base_width = Some(w);
                }
            }
        }

        if has_zwj {
            return CellWidth::Two;
        }
        if has_vs16 {
            return CellWidth::Two;
        }
        if has_vs15 {
            return CellWidth::One;
        }
        if ri_count >= 2 {
            return CellWidth::Two;
        }

        base_width.unwrap_or(CellWidth::Zero)
    }
}

impl WidthClassifier for DefaultClassifier {
    fn classify_grapheme(&self, s: &str) -> (Grapheme, CellWidth) {
        // Defensive: if callers hand us a multi-grapheme slice, segment
        // first and classify the FIRST grapheme only. This is what the
        // contract documents; it keeps callers honest during testing and
        // avoids misclassifying ZWJ sequences as multiple clusters.
        let first = s.graphemes(true).next().unwrap_or("");
        let width = self.cluster_width(first);
        (Grapheme::from_str_infallible(first), width)
    }

    fn wrap_eligible(
        &self,
        _prev: CellWidth,
        next: CellWidth,
        col: u16,
        cols: u16,
    ) -> WrapEligibility {
        // Zero-width combining marks attach to the preceding cluster and
        // do not advance the column. Caller applies without wrapping.
        if matches!(next, CellWidth::Zero) {
            return WrapEligibility::NoBreakHint;
        }
        // A full row is `cols` cells; legal cursor column range is [0, cols).
        // `next` fits if col + width <= cols.
        let needed = u32::from(next.cells());
        let remaining = u32::from(cols.saturating_sub(col));
        if needed <= remaining {
            WrapEligibility::Fits
        } else {
            WrapEligibility::MustWrap
        }
    }
}

/// Regional indicator symbol: U+1F1E6 (🇦) .. U+1F1FF (🇿). Two of these in
/// a grapheme cluster = a flag, 2 cells.
fn is_regional_indicator(c: char) -> bool {
    let cp = c as u32;
    (0x0001_F1E6..=0x0001_F1FF).contains(&cp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn narrow() -> DefaultClassifier {
        DefaultClassifier::new(AmbiguousWidthPolicy::Narrow)
    }

    fn wide() -> DefaultClassifier {
        DefaultClassifier::new(AmbiguousWidthPolicy::Wide)
    }

    #[test]
    fn ascii_is_one_cell() {
        let (g, w) = narrow().classify_grapheme("A");
        assert_eq!(g.as_str(), "A");
        assert_eq!(w, CellWidth::One);
    }

    #[test]
    fn korean_han_is_two_cells_retires_failure_mode_5() {
        // Retires RFC 0001 §22 #5 ("한 = 1 cell → column misalignment").
        let (_, w) = narrow().classify_grapheme("한");
        assert_eq!(w, CellWidth::Two);
    }

    #[test]
    fn zwj_family_is_two_cells_retires_failure_mode_6() {
        // Retires RFC 0001 §22 #6 (ZWJ emoji wrong-width → wrong substring).
        let cluster = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        let (g, w) = narrow().classify_grapheme(cluster);
        assert_eq!(g.as_str(), cluster);
        assert_eq!(w, CellWidth::Two);
    }

    #[test]
    fn vs16_widens_retires_failure_mode_7() {
        // Retires RFC 0001 §22 #7 (VS16 flipping width mid-stream).
        // `❤` (U+2764) alone is 1 cell; `❤️` (U+2764 U+FE0F) is 2 cells.
        let (_, w_bare) = narrow().classify_grapheme("\u{2764}");
        assert_eq!(w_bare, CellWidth::One);
        let (_, w_vs16) = narrow().classify_grapheme("\u{2764}\u{FE0F}");
        assert_eq!(w_vs16, CellWidth::Two);
    }

    #[test]
    fn vs15_narrows_emoji_presentation() {
        // 1️⃣ as `1 + VS16 + U+20E3` is 2 cells.
        // `1` + VS15 would be width 1 (text presentation).
        let (_, w_vs15) = narrow().classify_grapheme("1\u{FE0E}");
        assert_eq!(w_vs15, CellWidth::One);
    }

    #[test]
    fn combining_mark_yields_zero_width_when_isolated() {
        // COMBINING ACUTE ACCENT on its own is zero width (caller will
        // attach to preceding cluster).
        let (_, w) = narrow().classify_grapheme("\u{0301}");
        assert_eq!(w, CellWidth::Zero);
    }

    #[test]
    fn combining_mark_attached_to_e_is_one_cell() {
        // `e` + U+0301 = `é` — one grapheme, one cell.
        let (g, w) = narrow().classify_grapheme("e\u{0301}");
        assert_eq!(g.as_str(), "e\u{0301}");
        assert_eq!(w, CellWidth::One);
    }

    #[test]
    fn regional_indicator_pair_is_two() {
        // 🇰🇷 — KR flag, 2 cells.
        let (_, w) = narrow().classify_grapheme("\u{1F1F0}\u{1F1F7}");
        assert_eq!(w, CellWidth::Two);
    }

    #[test]
    fn dec_line_drawing_is_one_cell_even_in_cjk() {
        for cp in ['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼'] {
            let s = cp.to_string();
            assert_eq!(
                wide().classify_grapheme(&s).1,
                CellWidth::One,
                "DEC line-drawing {:?} must be 1 cell even in wide-ambig mode",
                cp,
            );
        }
    }

    #[test]
    fn arrow_glyphs_are_one_cell_in_wide_mode() {
        for cp in ['←', '↑', '→', '↓'] {
            let s = cp.to_string();
            assert_eq!(wide().classify_grapheme(&s).1, CellWidth::One);
        }
    }

    #[test]
    fn wrap_eligible_fits() {
        let c = narrow();
        // 1-cell at col 79 in 80-col row: fits (col 79 → col 80).
        assert_eq!(
            c.wrap_eligible(CellWidth::One, CellWidth::One, 79, 80),
            WrapEligibility::Fits,
        );
    }

    #[test]
    fn wrap_eligible_must_wrap_for_wide_at_last_col() {
        let c = narrow();
        // 2-cell at col 79 in 80-col row: needs 2 cells, remaining = 1
        // → MustWrap.
        assert_eq!(
            c.wrap_eligible(CellWidth::One, CellWidth::Two, 79, 80),
            WrapEligibility::MustWrap,
        );
    }

    #[test]
    fn wrap_eligible_wide_fits_at_penultimate() {
        let c = narrow();
        // 2-cell at col 78 in 80-col row: needs 2, remaining = 2 → Fits.
        assert_eq!(
            c.wrap_eligible(CellWidth::One, CellWidth::Two, 78, 80),
            WrapEligibility::Fits,
        );
    }

    #[test]
    fn wrap_eligible_zero_is_no_break_hint() {
        let c = narrow();
        assert_eq!(
            c.wrap_eligible(CellWidth::One, CellWidth::Zero, 5, 80),
            WrapEligibility::NoBreakHint,
        );
    }

    #[test]
    fn classify_grapheme_handles_empty() {
        let (g, w) = narrow().classify_grapheme("");
        assert!(g.is_empty());
        assert_eq!(w, CellWidth::Zero);
    }

    #[test]
    fn classify_grapheme_picks_first_cluster_if_multiple() {
        // `한국` — two graphemes. Contract: classify_grapheme returns the
        // first. (Callers using `classify_str` get both.)
        let (g, _) = narrow().classify_grapheme("한국");
        assert_eq!(g.as_str(), "한");
    }

    #[test]
    fn classify_str_yields_all_clusters() {
        let out = narrow().classify_str("Aé한");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].0.as_str(), "A");
        assert_eq!(out[0].1, CellWidth::One);
        assert_eq!(out[1].0.as_str(), "é");
        assert_eq!(out[1].1, CellWidth::One);
        assert_eq!(out[2].0.as_str(), "한");
        assert_eq!(out[2].1, CellWidth::Two);
    }
}
