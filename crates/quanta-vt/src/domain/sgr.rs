//! SGR (Select Graphic Rendition) pen state.
//!
//! The pen is the attributes + colors that stamp into each cell on write.
//! Per RFC 0001 §4.2, `CSI 0 m` and empty-param `CSI m` both reset; any
//! other param list composes.

use serde::{Deserialize, Serialize};

use crate::domain::cell::{Cell, CellAttrs, HyperlinkId};
use crate::domain::color::Color;

/// Live SGR pen state: colors + attribute flags + hyperlink anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SgrState {
    /// Foreground color written to the next cell.
    pub fg: Color,
    /// Background color written to the next cell.
    pub bg: Color,
    /// Attributes written to the next cell.
    pub attrs: CellAttrs,
    /// Currently open OSC 8 hyperlink, if any.
    pub hyperlink: Option<HyperlinkId>,
}

impl SgrState {
    /// Full-reset default — no attrs, default colors, no hyperlink.
    pub const DEFAULT: Self = Self {
        fg: Color::Default,
        bg: Color::Default,
        attrs: CellAttrs::empty(),
        hyperlink: None,
    };

    /// Reset the pen to default.
    pub fn reset(&mut self) {
        *self = Self::DEFAULT;
    }

    /// Stamp the pen state onto `cell`'s color + attribute fields. Does
    /// NOT touch `grapheme` or `width`.
    pub fn stamp(&self, cell: &mut Cell) {
        cell.fg = self.fg;
        cell.bg = self.bg;
        // Preserve `WIDE_CONTINUATION` — that's a grid-level flag, not an
        // SGR-level attribute.
        let keep = cell.attrs & CellAttrs::WIDE_CONTINUATION;
        cell.attrs = self.attrs | keep;
        cell.hyperlink = self.hyperlink;
    }

    /// Apply a single SGR param iterator yielding `u16` codes.
    ///
    /// Empty iterator (no params) → full reset, per xterm.
    ///
    /// # Supported subset (v1)
    ///
    /// - `0` — reset
    /// - `1..=9` — attrs bold/dim/italic/underline/blink/inverse/invisible/strike
    /// - `21` — double underline
    /// - `22..=29` — attr resets (bold/italic/underline/blink/inverse/invisible/strike)
    /// - `30..=37`, `39` — foreground palette-8 / default
    /// - `38;5;N` — foreground palette-256
    /// - `38;2;R;G;B` — foreground truecolor
    /// - `40..=47`, `49` — background palette-8 / default
    /// - `48;5;N`, `48;2;R;G;B` — background 256 / truecolor
    /// - `53` — overline, `55` — overline off
    /// - `90..=97` — bright foreground palette-8
    /// - `100..=107` — bright background palette-8
    ///
    /// Unknown codes silently advance; caller is expected to track them
    /// as a telemetry counter.
    pub fn apply_params<I>(&mut self, params: I) -> ApplyOutcome
    where
        I: IntoIterator<Item = u16>,
    {
        let mut iter = params.into_iter().peekable();
        let mut any = false;
        let mut unknown: u32 = 0;
        while let Some(p) = iter.next() {
            any = true;
            match p {
                0 => self.reset(),
                1 => self.attrs |= CellAttrs::BOLD,
                2 => self.attrs |= CellAttrs::DIM,
                3 => self.attrs |= CellAttrs::ITALIC,
                4 => self.attrs |= CellAttrs::UNDERLINE,
                5 | 6 => self.attrs |= CellAttrs::BLINK,
                7 => self.attrs |= CellAttrs::INVERSE,
                8 => self.attrs |= CellAttrs::INVISIBLE,
                9 => self.attrs |= CellAttrs::STRIKETHROUGH,
                21 => {
                    self.attrs |= CellAttrs::DOUBLE_UNDERLINE;
                    self.attrs &= !CellAttrs::UNDERLINE;
                }
                22 => self.attrs &= !(CellAttrs::BOLD | CellAttrs::DIM),
                23 => self.attrs &= !CellAttrs::ITALIC,
                24 => {
                    self.attrs &= !(CellAttrs::UNDERLINE
                        | CellAttrs::DOUBLE_UNDERLINE
                        | CellAttrs::CURLY_UNDERLINE);
                }
                25 => self.attrs &= !CellAttrs::BLINK,
                27 => self.attrs &= !CellAttrs::INVERSE,
                28 => self.attrs &= !CellAttrs::INVISIBLE,
                29 => self.attrs &= !CellAttrs::STRIKETHROUGH,
                30..=37 => self.fg = Color::Palette8((p - 30) as u8),
                38 => match parse_extended(&mut iter) {
                    Some(c) => self.fg = c,
                    None => unknown += 1,
                },
                39 => self.fg = Color::Default,
                40..=47 => self.bg = Color::Palette8((p - 40) as u8),
                48 => match parse_extended(&mut iter) {
                    Some(c) => self.bg = c,
                    None => unknown += 1,
                },
                49 => self.bg = Color::Default,
                53 => self.attrs |= CellAttrs::OVERLINE,
                55 => self.attrs &= !CellAttrs::OVERLINE,
                90..=97 => self.fg = Color::Palette8((p - 90 + 8) as u8),
                100..=107 => self.bg = Color::Palette8((p - 100 + 8) as u8),
                _ => unknown += 1,
            }
        }
        if !any {
            // `CSI m` with no params == `CSI 0 m`.
            self.reset();
        }
        ApplyOutcome { unknown }
    }
}

/// Telemetry-bearing return from [`SgrState::apply_params`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyOutcome {
    /// Number of SGR codes that fell through the known-set. Caller bumps
    /// `unknown_sgr` counter by this amount.
    pub unknown: u32,
}

/// Parse `38;5;N` / `38;2;R;G;B` (or `48;...`) extended-color tail from an
/// iterator positioned just past the leading `38` / `48`.
fn parse_extended<I: Iterator<Item = u16>>(iter: &mut std::iter::Peekable<I>) -> Option<Color> {
    let mode = iter.next()?;
    match mode {
        5 => {
            let idx = iter.next()?;
            Some(Color::Palette256((idx & 0xFF) as u8))
        }
        2 => {
            let r = iter.next()?;
            let g = iter.next()?;
            let b = iter.next()?;
            Some(Color::TrueColor {
                r: (r & 0xFF) as u8,
                g: (g & 0xFF) as u8,
                b: (b & 0xFF) as u8,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_params_reset() {
        let mut s = SgrState {
            fg: Color::Palette8(2),
            attrs: CellAttrs::BOLD,
            ..SgrState::DEFAULT
        };
        s.apply_params(std::iter::empty());
        assert_eq!(s, SgrState::DEFAULT);
    }

    #[test]
    fn explicit_zero_resets() {
        let mut s = SgrState {
            fg: Color::Palette8(2),
            ..SgrState::DEFAULT
        };
        s.apply_params([0u16]);
        assert_eq!(s, SgrState::DEFAULT);
    }

    #[test]
    fn bold_sets_flag() {
        let mut s = SgrState::default();
        s.apply_params([1u16]);
        assert!(s.attrs.contains(CellAttrs::BOLD));
    }

    #[test]
    fn fg_30_through_37() {
        for (i, code) in (30u16..=37).enumerate() {
            let mut s = SgrState::default();
            s.apply_params([code]);
            assert_eq!(s.fg, Color::Palette8(i as u8));
        }
    }

    #[test]
    fn bg_40_through_47() {
        for (i, code) in (40u16..=47).enumerate() {
            let mut s = SgrState::default();
            s.apply_params([code]);
            assert_eq!(s.bg, Color::Palette8(i as u8));
        }
    }

    #[test]
    fn bright_fg_90_through_97() {
        for (i, code) in (90u16..=97).enumerate() {
            let mut s = SgrState::default();
            s.apply_params([code]);
            assert_eq!(s.fg, Color::Palette8(i as u8 + 8));
        }
    }

    #[test]
    fn palette256_fg() {
        let mut s = SgrState::default();
        s.apply_params([38u16, 5, 123]);
        assert_eq!(s.fg, Color::Palette256(123));
    }

    #[test]
    fn truecolor_fg() {
        let mut s = SgrState::default();
        s.apply_params([38u16, 2, 10, 20, 30]);
        assert_eq!(
            s.fg,
            Color::TrueColor {
                r: 10,
                g: 20,
                b: 30
            }
        );
    }

    #[test]
    fn truecolor_bg() {
        let mut s = SgrState::default();
        s.apply_params([48u16, 2, 200, 100, 50]);
        assert_eq!(
            s.bg,
            Color::TrueColor {
                r: 200,
                g: 100,
                b: 50
            }
        );
    }

    #[test]
    fn default_fg_39() {
        let mut s = SgrState {
            fg: Color::Palette8(5),
            ..SgrState::DEFAULT
        };
        s.apply_params([39u16]);
        assert_eq!(s.fg, Color::Default);
    }

    #[test]
    fn default_bg_49() {
        let mut s = SgrState {
            bg: Color::Palette8(5),
            ..SgrState::DEFAULT
        };
        s.apply_params([49u16]);
        assert_eq!(s.bg, Color::Default);
    }

    #[test]
    fn chained_attrs() {
        let mut s = SgrState::default();
        s.apply_params([1u16, 3, 4, 31]);
        assert!(s.attrs.contains(CellAttrs::BOLD));
        assert!(s.attrs.contains(CellAttrs::ITALIC));
        assert!(s.attrs.contains(CellAttrs::UNDERLINE));
        assert_eq!(s.fg, Color::Palette8(1));
    }

    #[test]
    fn attr_reset_codes() {
        let mut s = SgrState {
            attrs: CellAttrs::BOLD | CellAttrs::ITALIC | CellAttrs::UNDERLINE,
            ..SgrState::DEFAULT
        };
        s.apply_params([22u16]);
        assert!(!s.attrs.contains(CellAttrs::BOLD));
        assert!(s.attrs.contains(CellAttrs::ITALIC));
        s.apply_params([23u16]);
        assert!(!s.attrs.contains(CellAttrs::ITALIC));
        s.apply_params([24u16]);
        assert!(!s.attrs.contains(CellAttrs::UNDERLINE));
    }

    #[test]
    fn overline_set_and_reset() {
        let mut s = SgrState::default();
        s.apply_params([53u16]);
        assert!(s.attrs.contains(CellAttrs::OVERLINE));
        s.apply_params([55u16]);
        assert!(!s.attrs.contains(CellAttrs::OVERLINE));
    }

    #[test]
    fn unknown_counted() {
        let mut s = SgrState::default();
        let out = s.apply_params([999u16, 500]);
        assert_eq!(out.unknown, 2);
    }

    #[test]
    fn stamp_preserves_wide_continuation() {
        let s = SgrState {
            attrs: CellAttrs::BOLD,
            ..SgrState::DEFAULT
        };
        let mut c = Cell::wide_continuation();
        s.stamp(&mut c);
        assert!(c.attrs.contains(CellAttrs::BOLD));
        assert!(c.attrs.contains(CellAttrs::WIDE_CONTINUATION));
    }
}
