//! Port trait for width classification.
//!
//! The engine and UI talk to width/grapheme via this trait so that:
//!
//! 1. Test doubles can inject a deterministic classifier (e.g. "every
//!    grapheme is 1 cell") without touching production code.
//! 2. A future per-session override (user-provided ambiguous-width map)
//!    can be introduced without recompiling call sites.
//! 3. The TS mirror's contract is exactly this trait's surface.
//!
//! The production implementation lives in
//! [`crate::adapters::DefaultClassifier`].

use crate::domain::{CellWidth, Grapheme, WrapEligibility};

/// Classify UTF-8 text into graphemes with display widths, and decide
/// wrap eligibility for each step.
///
/// Implementations MUST be deterministic: same input → same output,
/// forever. This is load-bearing for Rust↔TS parity.
pub trait WidthClassifier: Send + Sync {
    /// Classify a single grapheme cluster.
    ///
    /// `s` SHOULD be exactly one cluster; callers who have a larger string
    /// should segment first (using [`WidthClassifier::classify_str`]).
    /// Implementations MUST NOT panic on malformed or empty input — they
    /// return `(Grapheme::from_str(""), CellWidth::Zero)` as the neutral
    /// element.
    fn classify_grapheme(&self, s: &str) -> (Grapheme, CellWidth);

    /// Decide whether `next` can be placed at `col` on a row of width
    /// `cols`, given the width of the previous grapheme.
    ///
    /// Callers pass `prev = CellWidth::Zero` at the start of a row.
    fn wrap_eligible(
        &self,
        prev: CellWidth,
        next: CellWidth,
        col: u16,
        cols: u16,
    ) -> WrapEligibility;

    /// Segment a string into graphemes, classifying each.
    ///
    /// Default implementation iterates via [`WidthClassifier::classify_grapheme`].
    /// Adapters MAY override for performance (e.g. batch override-table
    /// lookups) but the output MUST be identical.
    fn classify_str(&self, s: &str) -> Vec<(Grapheme, CellWidth)> {
        use unicode_segmentation::UnicodeSegmentation;
        s.graphemes(true)
            .map(|g| self.classify_grapheme(g))
            .collect()
    }
}
