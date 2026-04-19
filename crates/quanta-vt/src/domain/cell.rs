//! Cell — the atomic unit of the terminal grid.
//!
//! Per RFC 0001 §13.2, a cell holds a grapheme cluster (not a `char`), a
//! semantic cell width, foreground / background color, attributes, and an
//! optional hyperlink id.
//!
//! Wide characters occupy two cells: the base cell holds the grapheme with
//! [`quanta_vt_width::CellWidth::Two`], and the following cell is a
//! "continuation" sibling with [`quanta_vt_width::CellWidth::Zero`] and the
//! [`CellAttrs::WIDE_CONTINUATION`] flag set.

use bitflags::bitflags;
use quanta_vt_width::{CellWidth, Grapheme};
use serde::{Deserialize, Serialize};

use crate::domain::color::Color;

bitflags! {
    /// Per-cell attribute bits.
    ///
    /// `Default` is all-unset. The SGR pen stamps these into each cell on
    /// write. `WIDE_CONTINUATION` is set internally on the right half of a
    /// 2-cell grapheme so selection / copy can skip it; it is NOT emitted by
    /// any SGR sequence.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
    pub struct CellAttrs: u16 {
        /// CSI 1 m. Brighter / bolder glyph.
        const BOLD               = 1 <<  0;
        /// CSI 2 m. Dimmer glyph (typically half-intensity).
        const DIM                = 1 <<  1;
        /// CSI 3 m. Italic.
        const ITALIC             = 1 <<  2;
        /// CSI 4 m. Straight underline.
        const UNDERLINE          = 1 <<  3;
        /// CSI 5 m / 6 m. Blinking glyph (renderer may ignore).
        const BLINK              = 1 <<  4;
        /// CSI 7 m. Reverse video (swap fg/bg at paint time).
        const INVERSE            = 1 <<  5;
        /// CSI 8 m. Invisible glyph (still copyable).
        const INVISIBLE          = 1 <<  6;
        /// CSI 9 m. Strikethrough.
        const STRIKETHROUGH      = 1 <<  7;
        /// CSI 21 m. Double underline.
        const DOUBLE_UNDERLINE   = 1 <<  8;
        /// CSI 4:3 m. Curly / squiggly underline (kitty extension).
        const CURLY_UNDERLINE    = 1 <<  9;
        /// CSI 53 m. Overline.
        const OVERLINE           = 1 << 10;
        /// Right half of a 2-cell grapheme. Never painted; marked so
        /// selection / copy can skip it.
        const WIDE_CONTINUATION  = 1 << 11;
    }
}

/// Opaque id for an OSC 8 hyperlink. Allocated by the grid; valid until the
/// URL is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HyperlinkId(pub u32);

/// A single cell on the grid.
///
/// **Invariants**:
///
/// - `width == CellWidth::Zero` implies either (a) the cell is blank
///   (grapheme empty, no `WIDE_CONTINUATION`), or (b) the cell is a
///   wide-char continuation (empty grapheme, `WIDE_CONTINUATION` set).
/// - `width == CellWidth::Two` implies the next cell on the row is a
///   continuation sibling.
/// - `grapheme` stores raw UTF-8 — never normalized; grid honors the bytes
///   as fed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    /// Grapheme cluster. Empty for blank cells and continuation siblings.
    pub grapheme: Grapheme,
    /// Semantic cell width (0 / 1 / 2).
    pub width: CellWidth,
    /// Foreground color.
    pub fg: Color,
    /// Background color.
    pub bg: Color,
    /// Attributes.
    pub attrs: CellAttrs,
    /// Optional OSC 8 hyperlink id.
    pub hyperlink: Option<HyperlinkId>,
}

impl Cell {
    /// Blank cell with default colors and no attributes.
    ///
    /// Used to initialize fresh rows and pad after ED/EL erase operations.
    pub const EMPTY_WIDTH: CellWidth = CellWidth::One;

    /// Construct an [`Cell::EMPTY_WIDTH`] blank cell.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            grapheme: Grapheme::from_str_infallible(""),
            width: Self::EMPTY_WIDTH,
            fg: Color::Default,
            bg: Color::Default,
            attrs: CellAttrs::empty(),
            hyperlink: None,
        }
    }

    /// Construct a wide-char continuation sibling cell.
    #[must_use]
    pub fn wide_continuation() -> Self {
        Self {
            grapheme: Grapheme::from_str_infallible(""),
            width: CellWidth::Zero,
            fg: Color::Default,
            bg: Color::Default,
            attrs: CellAttrs::WIDE_CONTINUATION,
            hyperlink: None,
        }
    }

    /// True if this cell is the right half of a 2-cell grapheme.
    #[must_use]
    pub fn is_wide_continuation(&self) -> bool {
        self.attrs.contains(CellAttrs::WIDE_CONTINUATION)
    }

    /// True if this cell is blank (empty grapheme, not a continuation).
    #[must_use]
    pub fn is_blank(&self) -> bool {
        self.grapheme.is_empty() && !self.is_wide_continuation()
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cell_is_blank() {
        let c = Cell::empty();
        assert!(c.is_blank());
        assert!(!c.is_wide_continuation());
        assert_eq!(c.width, CellWidth::One);
    }

    #[test]
    fn wide_continuation_is_marked() {
        let c = Cell::wide_continuation();
        assert!(c.is_wide_continuation());
        assert!(!c.is_blank());
        assert_eq!(c.width, CellWidth::Zero);
    }

    #[test]
    fn cell_attrs_default_empty() {
        assert_eq!(CellAttrs::default(), CellAttrs::empty());
    }

    #[test]
    fn cell_attrs_compose() {
        let a = CellAttrs::BOLD | CellAttrs::ITALIC;
        assert!(a.contains(CellAttrs::BOLD));
        assert!(a.contains(CellAttrs::ITALIC));
        assert!(!a.contains(CellAttrs::UNDERLINE));
    }

    #[test]
    fn hyperlink_id_round_trips_hash() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        set.insert(HyperlinkId(42));
        assert!(set.contains(&HyperlinkId(42)));
        assert!(!set.contains(&HyperlinkId(43)));
    }
}
