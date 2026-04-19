//! Color value types.
//!
//! The VT engine recognises four color forms (RFC 0001 §7.1.1):
//!
//! 1. [`Color::Default`] — terminal-default foreground / background. Rendered
//!    according to the UI theme; no `(r, g, b)` baked in.
//! 2. [`Color::Palette8`] — ANSI 16-color palette (`0..=15`). Bright bit
//!    (values `8..=15`) is baked into the variant's `u8`.
//! 3. [`Color::Palette256`] — xterm 256-color extension.
//! 4. [`Color::TrueColor`] — 24-bit RGB.

use serde::{Deserialize, Serialize};

/// A cell's foreground or background color.
///
/// Discriminant-based so `(fg, bg)` in a `Cell` costs 2 × (1 byte tag +
/// 3 byte payload) = 8 bytes — small enough to keep `Cell` in a single
/// cache line for ASCII-heavy rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Default)]
pub enum Color {
    /// Terminal-default color (theme-resolved at paint time).
    #[default]
    Default,
    /// ANSI 16-color palette (`0..=7` normal, `8..=15` bright).
    Palette8(u8),
    /// xterm 256-color.
    Palette256(u8),
    /// 24-bit RGB.
    TrueColor { r: u8, g: u8, b: u8 },
}

/// Named palette-8 entries. Helper for SGR decoding; the underlying wire
/// value is [`Color::Palette8`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
#[allow(missing_docs)]
pub enum NamedColor {
    Black = 0,
    Red = 1,
    Green = 2,
    Yellow = 3,
    Blue = 4,
    Magenta = 5,
    Cyan = 6,
    White = 7,
    BrightBlack = 8,
    BrightRed = 9,
    BrightGreen = 10,
    BrightYellow = 11,
    BrightBlue = 12,
    BrightMagenta = 13,
    BrightCyan = 14,
    BrightWhite = 15,
}

impl NamedColor {
    /// Map SGR `30..=37` / `40..=47` / `90..=97` / `100..=107` indices to a
    /// [`NamedColor`]. Returns [`None`] for out-of-range indices.
    #[must_use]
    pub fn from_index(idx: u8) -> Option<Self> {
        match idx {
            0 => Some(Self::Black),
            1 => Some(Self::Red),
            2 => Some(Self::Green),
            3 => Some(Self::Yellow),
            4 => Some(Self::Blue),
            5 => Some(Self::Magenta),
            6 => Some(Self::Cyan),
            7 => Some(Self::White),
            8 => Some(Self::BrightBlack),
            9 => Some(Self::BrightRed),
            10 => Some(Self::BrightGreen),
            11 => Some(Self::BrightYellow),
            12 => Some(Self::BrightBlue),
            13 => Some(Self::BrightMagenta),
            14 => Some(Self::BrightCyan),
            15 => Some(Self::BrightWhite),
            _ => None,
        }
    }

    /// Bare `u8` index (`0..=15`) for palette-8 serialization.
    #[must_use]
    pub const fn index(self) -> u8 {
        self as u8
    }

    /// Convenience conversion to [`Color::Palette8`].
    #[must_use]
    pub const fn to_color(self) -> Color {
        Color::Palette8(self as u8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_default() {
        assert_eq!(Color::default(), Color::Default);
    }

    #[test]
    fn named_color_round_trip() {
        for i in 0..=15u8 {
            let nc = NamedColor::from_index(i).expect("valid index");
            assert_eq!(nc.index(), i);
        }
        assert!(NamedColor::from_index(16).is_none());
    }

    #[test]
    fn named_color_to_color() {
        assert_eq!(NamedColor::Red.to_color(), Color::Palette8(1));
        assert_eq!(NamedColor::BrightWhite.to_color(), Color::Palette8(15));
    }

    #[test]
    fn colors_equal_for_hash_set_membership() {
        use std::collections::HashSet;
        let mut set: HashSet<Color> = HashSet::new();
        set.insert(Color::TrueColor { r: 1, g: 2, b: 3 });
        assert!(set.contains(&Color::TrueColor { r: 1, g: 2, b: 3 }));
        assert!(!set.contains(&Color::TrueColor { r: 1, g: 2, b: 4 }));
    }
}
