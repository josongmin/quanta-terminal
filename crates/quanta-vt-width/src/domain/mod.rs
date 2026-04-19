//! Domain types for width / grapheme / wrap classification.
//!
//! Pure value types. No IO, no tokio, no regex. This module compiles even
//! if every adapter is stripped out — the ADR 0014 hex rule.

use std::fmt;

use serde::{Deserialize, Serialize};
use smallstr::SmallString;

/// Number of terminal cells occupied by a single grapheme cluster.
///
/// The terminal grid is a fixed cell width, so every grapheme maps to
/// exactly one of these three values. Combining marks and zero-width
/// joiner-continuations are [`CellWidth::Zero`] (they attach to the
/// preceding grapheme). Most text is [`CellWidth::One`]. CJK ideographs
/// and emoji presentation sequences are [`CellWidth::Two`].
///
/// Serialization form is the string `"zero" | "one" | "two"` so the TS
/// mirror can share the same golden fixtures without a numeric mapping.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[must_use]
pub enum CellWidth {
    /// Combining marks, VS15 applied to emoji-presentation, ZWJ continuation parts.
    Zero,
    /// ASCII, Latin-1, most Latin Extended, DEC line-drawing, half-width kana.
    One,
    /// CJK ideographs, emoji presentation, full-width forms, VS16 applied to text-presentation.
    Two,
}

impl CellWidth {
    /// Number of cells as a `u16`. Handy for column arithmetic in the VT engine.
    #[must_use]
    pub const fn cells(self) -> u16 {
        match self {
            Self::Zero => 0,
            Self::One => 1,
            Self::Two => 2,
        }
    }

    /// Construct from a `usize` width value produced by `unicode-width`.
    ///
    /// Returns [`None`] for values > 2 — `unicode-width` never emits > 2 for
    /// real code points, but we refuse to silently clamp in library code.
    pub const fn from_ucd_width(w: usize) -> Option<Self> {
        match w {
            0 => Some(Self::Zero),
            1 => Some(Self::One),
            2 => Some(Self::Two),
            _ => None,
        }
    }
}

impl fmt::Display for CellWidth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Zero => "zero",
            Self::One => "one",
            Self::Two => "two",
        })
    }
}

/// A single grapheme cluster — user-perceived character — stored inline
/// when short enough.
///
/// `SmallString<[u8; 8]>` keeps ASCII, Latin-1, and the majority of single
/// CJK code points on the stack. Complex ZWJ emoji spill to the heap; the
/// common case stays alloc-free.
///
/// **Invariant**: `as_str()` returns the exact UTF-8 bytes fed in —
/// unmodified, unnormalized. The grid is responsible for display, not
/// normalization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Grapheme(SmallString<[u8; 8]>);

impl Grapheme {
    /// Build a grapheme from a `&str` slice.
    ///
    /// The slice SHOULD already be a single grapheme cluster; callers who
    /// need segmentation should go through [`crate::WidthClassifier`].
    #[must_use]
    pub fn from_str(s: &str) -> Self {
        Self(SmallString::from_str(s))
    }

    /// Borrow the underlying UTF-8 bytes as a `&str`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// Byte length of the grapheme's UTF-8 encoding.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True if the grapheme is empty (only meaningful as a "no grapheme" sentinel).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for Grapheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<&str> for Grapheme {
    fn from(s: &str) -> Self {
        Self::from_str(s)
    }
}

/// Host OS family — used by [`AmbiguousWidthPolicy::resolve`] to pick a
/// sensible default for East-Asian Ambiguous characters.
///
/// The engine receives this once per session from the host and holds it for
/// the lifetime. `$LANG` / locale changes mid-session require a grid
/// re-flow; not a library concern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[must_use]
pub enum OsKind {
    MacOs,
    Windows,
    Linux,
    /// Any other Unix-family OS (BSD, illumos, etc.). Treated as Linux for
    /// policy purposes — CJK locale → Wide, otherwise Narrow.
    OtherUnix,
}

/// Policy for East-Asian Ambiguous width characters (UAX #11).
///
/// Ambiguous characters can be rendered either 1 cell or 2 cells
/// depending on locale. One wrong choice and every column after the
/// character is misaligned, so this can't be a runtime heuristic — it's a
/// per-session setting, resolved once on boot, held for the lifetime.
///
/// Defaults (per RFC 0001 §8.1 and ADR 0015):
///
/// - macOS / Windows → [`AmbiguousWidthPolicy::Narrow`] (matches Apple
///   Terminal / Windows Terminal).
/// - Linux with `$LANG` containing `ko`, `ja`, or `zh` → [`AmbiguousWidthPolicy::Wide`].
/// - Linux otherwise → [`AmbiguousWidthPolicy::Narrow`].
///
/// Users override via Settings; the override flows through as
/// [`AmbiguousWidthPolicy::Narrow`] or [`AmbiguousWidthPolicy::Wide`]
/// directly, bypassing [`AmbiguousWidthPolicy::Auto`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[must_use]
pub enum AmbiguousWidthPolicy {
    /// Ambiguous → 1 cell.
    Narrow,
    /// Ambiguous → 2 cells.
    Wide,
    /// Resolve via [`AmbiguousWidthPolicy::resolve`] at session boot.
    Auto,
}

impl AmbiguousWidthPolicy {
    /// Resolve an `Auto` policy against the host OS and (optional) `$LANG`.
    ///
    /// This function is total and deterministic — given the same
    /// `(os, lang)` pair it always returns the same value. The parity test
    /// pins all six documented cases.
    ///
    /// # Cases
    ///
    /// - `(MacOs, _)` → `Narrow`
    /// - `(Windows, _)` → `Narrow`
    /// - `(Linux | OtherUnix, Some(lang))` where lang contains `ko` / `ja` / `zh` → `Wide`
    /// - `(Linux | OtherUnix, _)` otherwise → `Narrow`
    ///
    /// Note: already-resolved `Narrow` / `Wide` pass through unchanged, so
    /// callers can call `.resolve(...)` unconditionally.
    pub fn resolve(self, os: OsKind, lang: Option<&str>) -> Self {
        match self {
            Self::Narrow | Self::Wide => self,
            Self::Auto => match os {
                OsKind::MacOs | OsKind::Windows => Self::Narrow,
                OsKind::Linux | OsKind::OtherUnix => {
                    if Self::lang_is_cjk(lang) {
                        Self::Wide
                    } else {
                        Self::Narrow
                    }
                }
            },
        }
    }

    /// True if `$LANG` looks CJK. Case-insensitive substring match on
    /// `ko`, `ja`, `zh`. Covers `ko_KR.UTF-8`, `ja_JP`, `zh_CN.GB18030`,
    /// `zh-Hant`, etc.
    fn lang_is_cjk(lang: Option<&str>) -> bool {
        let Some(lang) = lang else {
            return false;
        };
        let lower = lang.to_ascii_lowercase();
        lower.contains("ko") || lower.contains("ja") || lower.contains("zh")
    }

    /// True if this policy says Ambiguous → Wide (i.e. 2 cells).
    #[must_use]
    pub fn is_wide(self) -> bool {
        matches!(self, Self::Wide)
    }
}

/// Whether a grapheme fits in the current row, must wrap to the next row,
/// or is a hard no-break hint.
///
/// Consumed by `quanta-vt`'s line-wrap logic (EPIC-B). The exact rule is:
///
/// - `Fits` — the grapheme fits in `col..col + width <= cols`.
/// - `MustWrap` — the grapheme is 2 cells and `col + 2 > cols`. A 2-cell
///   character must NEVER be split across rows; it is flushed whole to the
///   next row and the last column on the previous row is left blank.
/// - `NoBreakHint` — the grapheme is zero-width (combining mark / ZWJ
///   continuation) and attaches to the preceding cluster; caller should
///   apply it without advancing the column cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[must_use]
pub enum WrapEligibility {
    Fits,
    MustWrap,
    NoBreakHint,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_width_cells_roundtrips() {
        assert_eq!(CellWidth::Zero.cells(), 0);
        assert_eq!(CellWidth::One.cells(), 1);
        assert_eq!(CellWidth::Two.cells(), 2);
    }

    #[test]
    fn cell_width_from_ucd_rejects_out_of_range() {
        assert_eq!(CellWidth::from_ucd_width(0), Some(CellWidth::Zero));
        assert_eq!(CellWidth::from_ucd_width(1), Some(CellWidth::One));
        assert_eq!(CellWidth::from_ucd_width(2), Some(CellWidth::Two));
        assert_eq!(CellWidth::from_ucd_width(3), None);
        assert_eq!(CellWidth::from_ucd_width(usize::MAX), None);
    }

    #[test]
    fn grapheme_preserves_bytes_exactly() {
        let s = "👨\u{200d}👩\u{200d}👧\u{200d}👦"; // ZWJ family
        let g = Grapheme::from_str(s);
        assert_eq!(g.as_str(), s);
        assert_eq!(g.len(), s.len());
    }

    #[test]
    fn grapheme_inline_for_short_ascii() {
        // SmallString keeps <= 8 bytes inline. `"hello"` is 5 bytes.
        let g = Grapheme::from_str("hello");
        assert_eq!(g.as_str(), "hello");
    }

    #[test]
    fn ambig_resolve_mac_is_narrow() {
        let r =
            AmbiguousWidthPolicy::Auto.resolve(OsKind::MacOs, Some("ko_KR.UTF-8"));
        assert_eq!(r, AmbiguousWidthPolicy::Narrow);
    }

    #[test]
    fn ambig_resolve_windows_is_narrow() {
        let r =
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Windows, Some("ja_JP.UTF-8"));
        assert_eq!(r, AmbiguousWidthPolicy::Narrow);
    }

    #[test]
    fn ambig_resolve_linux_cjk_is_wide() {
        assert_eq!(
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Linux, Some("ko_KR.UTF-8")),
            AmbiguousWidthPolicy::Wide,
        );
        assert_eq!(
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Linux, Some("ja_JP.UTF-8")),
            AmbiguousWidthPolicy::Wide,
        );
        assert_eq!(
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Linux, Some("zh_CN.UTF-8")),
            AmbiguousWidthPolicy::Wide,
        );
    }

    #[test]
    fn ambig_resolve_linux_non_cjk_is_narrow() {
        assert_eq!(
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Linux, Some("en_US.UTF-8")),
            AmbiguousWidthPolicy::Narrow,
        );
        assert_eq!(
            AmbiguousWidthPolicy::Auto.resolve(OsKind::Linux, None),
            AmbiguousWidthPolicy::Narrow,
        );
    }

    #[test]
    fn ambig_resolve_explicit_passes_through() {
        assert_eq!(
            AmbiguousWidthPolicy::Narrow
                .resolve(OsKind::Linux, Some("ko_KR.UTF-8")),
            AmbiguousWidthPolicy::Narrow,
        );
        assert_eq!(
            AmbiguousWidthPolicy::Wide.resolve(OsKind::MacOs, None),
            AmbiguousWidthPolicy::Wide,
        );
    }
}
