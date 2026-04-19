//! Charset tests — G0-G3 designators, SS2/SS3, DEC line drawing.

mod common;

use common::grid;

#[test]
fn select_g0_dec_graphics_then_print() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b(0q");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "─");
}

#[test]
fn select_g0_ascii_passthrough() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b(0q\x1b(Bq");
    assert_eq!(g.snapshot().cells[0][1].grapheme.as_str(), "q");
}

#[test]
fn g1_designator_and_shift_out() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b)0");
    let _ = g.feed(b"\x0e");
    let _ = g.feed(b"q");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "─");
    let _ = g.feed(b"\x0f");
    let _ = g.feed(b"q");
    assert_eq!(g.snapshot().cells[0][1].grapheme.as_str(), "q");
}

#[test]
fn g2_designator_and_single_shift_2() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b*0");
    let _ = g.feed(b"\x1bN");
    let _ = g.feed(b"q");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "─");
    // SS2 consumed — next print is via GL again.
    let _ = g.feed(b"q");
    assert_eq!(g.snapshot().cells[0][1].grapheme.as_str(), "q");
}

#[test]
fn g3_designator_and_single_shift_3() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b+0");
    let _ = g.feed(b"\x1bO");
    let _ = g.feed(b"x");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "│");
}

#[test]
fn uk_charset_converts_hash() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b(A#");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "£");
}

#[test]
fn dec_line_drawing_full_box() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b(0lqk");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "┌");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "─");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "┐");
}

#[test]
fn non_ascii_passthrough_under_dec_graphics() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b(0");
    // Korean char — non-ASCII, not in graphics range, pass through.
    let _ = g.feed("한".as_bytes());
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "한");
}

#[test]
fn shift_in_after_shift_out_restores() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b)0");
    let _ = g.feed(b"\x0eq");
    let _ = g.feed(b"\x0fq");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "─");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "q");
}

#[test]
fn multiple_single_shifts_consumed_individually() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b*0");
    let _ = g.feed(b"\x1bNqABC");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "─");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "A");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "B");
}

#[test]
fn unknown_designator_bumps_nothing_visible() {
    let mut g = grid(3, 10);
    // Designator 'Z' isn't recognised — current charset unchanged.
    let _ = g.feed(b"\x1b(Z");
    let _ = g.feed(b"q");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "q");
}
