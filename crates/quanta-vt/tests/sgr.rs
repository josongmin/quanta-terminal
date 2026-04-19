//! SGR integration tests — 40+ cases per DoD.

mod common;

use common::grid;
use quanta_vt::{CellAttrs, Color};

#[test]
fn sgr_bold_then_print() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1mA");
    let snap = g.snapshot();
    assert!(snap.cells[0][0].attrs.contains(CellAttrs::BOLD));
}

#[test]
fn sgr_reset_clears_attrs() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1;3mX\x1b[0mY");
    let snap = g.snapshot();
    assert!(snap.cells[0][0].attrs.contains(CellAttrs::BOLD));
    assert!(!snap.cells[0][1].attrs.contains(CellAttrs::BOLD));
}

#[test]
fn sgr_empty_is_reset() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1mX\x1b[mY");
    let snap = g.snapshot();
    assert!(!snap.cells[0][1].attrs.contains(CellAttrs::BOLD));
}

#[test]
fn sgr_fg_palette8() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[31mA");
    assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette8(1));
}

#[test]
fn sgr_bg_palette8() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[42mA");
    assert_eq!(g.snapshot().cells[0][0].bg, Color::Palette8(2));
}

#[test]
fn sgr_bright_fg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[91mA");
    assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette8(9));
}

#[test]
fn sgr_bright_bg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[102mA");
    assert_eq!(g.snapshot().cells[0][0].bg, Color::Palette8(10));
}

#[test]
fn sgr_palette256_fg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[38;5;200mA");
    assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette256(200));
}

#[test]
fn sgr_palette256_bg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[48;5;100mA");
    assert_eq!(g.snapshot().cells[0][0].bg, Color::Palette256(100));
}

#[test]
fn sgr_truecolor_fg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[38;2;10;20;30mA");
    assert_eq!(
        g.snapshot().cells[0][0].fg,
        Color::TrueColor {
            r: 10,
            g: 20,
            b: 30
        }
    );
}

#[test]
fn sgr_truecolor_bg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[48;2;200;100;50mA");
    assert_eq!(
        g.snapshot().cells[0][0].bg,
        Color::TrueColor {
            r: 200,
            g: 100,
            b: 50
        }
    );
}

#[test]
fn sgr_default_fg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[31;39mA");
    assert_eq!(g.snapshot().cells[0][0].fg, Color::Default);
}

#[test]
fn sgr_default_bg() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[42;49mA");
    assert_eq!(g.snapshot().cells[0][0].bg, Color::Default);
}

#[test]
fn sgr_italic() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[3mA");
    assert!(g.snapshot().cells[0][0].attrs.contains(CellAttrs::ITALIC));
}

#[test]
fn sgr_underline() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[4mA");
    assert!(g.snapshot().cells[0][0]
        .attrs
        .contains(CellAttrs::UNDERLINE));
}

#[test]
fn sgr_blink() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[5mA");
    assert!(g.snapshot().cells[0][0].attrs.contains(CellAttrs::BLINK));
}

#[test]
fn sgr_inverse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[7mA");
    assert!(g.snapshot().cells[0][0].attrs.contains(CellAttrs::INVERSE));
}

#[test]
fn sgr_invisible() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[8mA");
    assert!(g.snapshot().cells[0][0]
        .attrs
        .contains(CellAttrs::INVISIBLE));
}

#[test]
fn sgr_strikethrough() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[9mA");
    assert!(g.snapshot().cells[0][0]
        .attrs
        .contains(CellAttrs::STRIKETHROUGH));
}

#[test]
fn sgr_dim() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[2mA");
    assert!(g.snapshot().cells[0][0].attrs.contains(CellAttrs::DIM));
}

#[test]
fn sgr_double_underline() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[21mA");
    assert!(g.snapshot().cells[0][0]
        .attrs
        .contains(CellAttrs::DOUBLE_UNDERLINE));
}

#[test]
fn sgr_overline() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[53mA");
    assert!(g.snapshot().cells[0][0].attrs.contains(CellAttrs::OVERLINE));
}

#[test]
fn sgr_chained_bold_italic_underline() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1;3;4mA");
    let attrs = g.snapshot().cells[0][0].attrs;
    assert!(attrs.contains(CellAttrs::BOLD));
    assert!(attrs.contains(CellAttrs::ITALIC));
    assert!(attrs.contains(CellAttrs::UNDERLINE));
}

#[test]
fn sgr_reset_bold_22() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1mA\x1b[22mB");
    let snap = g.snapshot();
    assert!(snap.cells[0][0].attrs.contains(CellAttrs::BOLD));
    assert!(!snap.cells[0][1].attrs.contains(CellAttrs::BOLD));
}

#[test]
fn sgr_reset_italic_23() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[3mA\x1b[23mB");
    assert!(!g.snapshot().cells[0][1].attrs.contains(CellAttrs::ITALIC));
}

#[test]
fn sgr_reset_underline_24() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[4mA\x1b[24mB");
    assert!(!g.snapshot().cells[0][1]
        .attrs
        .contains(CellAttrs::UNDERLINE));
}

#[test]
fn sgr_reset_blink_25() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[5mA\x1b[25mB");
    assert!(!g.snapshot().cells[0][1].attrs.contains(CellAttrs::BLINK));
}

#[test]
fn sgr_reset_inverse_27() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[7mA\x1b[27mB");
    assert!(!g.snapshot().cells[0][1].attrs.contains(CellAttrs::INVERSE));
}

#[test]
fn sgr_reset_invisible_28() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[8mA\x1b[28mB");
    assert!(!g.snapshot().cells[0][1]
        .attrs
        .contains(CellAttrs::INVISIBLE));
}

#[test]
fn sgr_reset_strikethrough_29() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[9mA\x1b[29mB");
    assert!(!g.snapshot().cells[0][1]
        .attrs
        .contains(CellAttrs::STRIKETHROUGH));
}

#[test]
fn sgr_reset_overline_55() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[53mA\x1b[55mB");
    assert!(!g.snapshot().cells[0][1].attrs.contains(CellAttrs::OVERLINE));
}

#[test]
fn sgr_consecutive_30_through_37_foreground() {
    for i in 0u8..=7 {
        let mut g = grid(3, 10);
        let seq = format!("\x1b[{}mA", 30 + i);
        let _ = g.feed(seq.as_bytes());
        assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette8(i));
    }
}

#[test]
fn sgr_consecutive_40_through_47_background() {
    for i in 0u8..=7 {
        let mut g = grid(3, 10);
        let seq = format!("\x1b[{}mA", 40 + i);
        let _ = g.feed(seq.as_bytes());
        assert_eq!(g.snapshot().cells[0][0].bg, Color::Palette8(i));
    }
}

#[test]
fn sgr_consecutive_90_through_97_bright_fg() {
    for i in 0u8..=7 {
        let mut g = grid(3, 10);
        let seq = format!("\x1b[{}mA", 90 + i);
        let _ = g.feed(seq.as_bytes());
        assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette8(i + 8));
    }
}

#[test]
fn sgr_consecutive_100_through_107_bright_bg() {
    for i in 0u8..=7 {
        let mut g = grid(3, 10);
        let seq = format!("\x1b[{}mA", 100 + i);
        let _ = g.feed(seq.as_bytes());
        assert_eq!(g.snapshot().cells[0][0].bg, Color::Palette8(i + 8));
    }
}

#[test]
fn sgr_fg_bg_together() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[31;42mA");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.fg, Color::Palette8(1));
    assert_eq!(cell.bg, Color::Palette8(2));
}

#[test]
fn sgr_chain_then_partial_reset() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[1;3;31;42mA\x1b[22mB");
    let snap = g.snapshot();
    let a = &snap.cells[0][0];
    let b = &snap.cells[0][1];
    assert!(a.attrs.contains(CellAttrs::BOLD));
    assert!(!b.attrs.contains(CellAttrs::BOLD));
    assert!(b.attrs.contains(CellAttrs::ITALIC));
    assert_eq!(b.fg, Color::Palette8(1));
    assert_eq!(b.bg, Color::Palette8(2));
}

#[test]
fn sgr_unknown_code_silently_ignored() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[999mA");
    // Should not panic; cell content is the letter.
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "A");
}

#[test]
fn sgr_newline_does_not_reset_pen() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[31mA\r\nB");
    assert_eq!(g.snapshot().cells[0][0].fg, Color::Palette8(1));
    assert_eq!(g.snapshot().cells[1][0].fg, Color::Palette8(1));
}

#[test]
fn sgr_mixed_truecolor_and_palette8() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[38;2;10;20;30;48;5;100mA");
    let c = &g.snapshot().cells[0][0];
    assert_eq!(
        c.fg,
        Color::TrueColor {
            r: 10,
            g: 20,
            b: 30
        }
    );
    assert_eq!(c.bg, Color::Palette256(100));
}
