//! Grapheme + width integration (uses SSOT from quanta-vt-width).

mod common;

use common::grid;
use quanta_vt::CellAttrs;
use quanta_vt_width::CellWidth;

#[test]
fn ascii_is_one_cell() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"A");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::One);
    assert_eq!(g.cursor().col, 1);
}

#[test]
fn korean_han_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("한".as_bytes());
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.grapheme.as_str(), "한");
    assert_eq!(cell.width, CellWidth::Two);
    assert_eq!(g.cursor().col, 2);
}

#[test]
fn wide_continuation_cell_marker_set() {
    let mut g = grid(3, 10);
    let _ = g.feed("한".as_bytes());
    let row = &g.snapshot().cells[0];
    assert!(row[1].is_wide_continuation());
}

#[test]
fn zwj_emoji_family_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("👨\u{200d}👩\u{200d}👧\u{200d}👦".as_bytes());
    // Flush may need another char. Feed a sentinel to close the cluster.
    let _ = g.feed(b" ");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn combining_mark_zero_width_attaches_to_prev() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"e");
    let _ = g.feed("\u{0301}".as_bytes());
    let _ = g.feed(b"X");
    let snap = g.snapshot();
    // `e` + acute → single cell at col 0.
    assert!(snap.cells[0][0].grapheme.as_str().starts_with('e'));
    // Cursor advanced only 2 columns total (é + X).
    assert_eq!(g.cursor().col, 2);
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "X");
}

#[test]
fn vs16_retains_width_two() {
    let mut g = grid(3, 10);
    let _ = g.feed("❤️".as_bytes());
    // Emit sentinel to flush.
    let _ = g.feed(b" ");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn typing_across_wide_boundary() {
    let mut g = grid(3, 10);
    let _ = g.feed("A한B".as_bytes());
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "A");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "한");
    assert!(snap.cells[0][2].is_wide_continuation());
    assert_eq!(snap.cells[0][3].grapheme.as_str(), "B");
}

#[test]
fn cursor_advances_by_width() {
    let mut g = grid(3, 10);
    let _ = g.feed("A한".as_bytes());
    assert_eq!(g.cursor().col, 3);
}

#[test]
fn wide_char_wraps_to_next_row_at_last_col() {
    let mut g = grid(3, 5);
    let _ = g.feed("XXXX".as_bytes());
    assert_eq!(g.cursor().col, 4);
    // Next 2-cell wide char should wrap.
    let _ = g.feed("한".as_bytes());
    // 한 should land at row 1, col 0. Cursor after it at col 2.
    assert_eq!(g.cursor().row, 1);
}

#[test]
fn ascii_wrap_at_row_end() {
    let mut g = grid(3, 5);
    let _ = g.feed(b"ABCDEF");
    // After ABCDE (fills row), F goes to row 1.
    assert_eq!(g.cursor().row, 1);
}

#[test]
fn multi_cluster_string() {
    let mut g = grid(3, 20);
    let _ = g.feed("Hello 한글!".as_bytes());
    let _ = g.feed(b" ");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "H");
    assert_eq!(snap.cells[0][6].grapheme.as_str(), "한");
}

#[test]
fn wide_continuation_has_wide_continuation_attr() {
    let mut g = grid(3, 10);
    let _ = g.feed("한".as_bytes());
    let row = &g.snapshot().cells[0];
    assert!(row[1].attrs.contains(CellAttrs::WIDE_CONTINUATION));
}

#[test]
fn ascii_cursor_advance_by_one() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"A");
    assert_eq!(g.cursor().col, 1);
}

#[test]
fn korean_string_gananada_fills_correctly() {
    let mut g = grid(3, 20);
    let _ = g.feed("가나다".as_bytes());
    let _ = g.feed(b" ");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "가");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "나");
    assert_eq!(snap.cells[0][4].grapheme.as_str(), "다");
}

#[test]
fn japanese_hiragana_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("あ".as_bytes());
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn chinese_hanzi_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("汉".as_bytes());
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn simple_emoji_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("🙂".as_bytes());
    let _ = g.feed(b" ");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn mixed_ascii_wide_ascii_cursor_arithmetic() {
    let mut g = grid(3, 20);
    let _ = g.feed("a汉b".as_bytes());
    // a (col 1), 汉 (col 3), b (col 4).
    assert_eq!(g.cursor().col, 4);
}

#[test]
fn regional_indicator_flag_is_two_cells() {
    let mut g = grid(3, 10);
    let _ = g.feed("\u{1F1F0}\u{1F1F7}".as_bytes());
    let _ = g.feed(b" ");
    let cell = &g.snapshot().cells[0][0];
    assert_eq!(cell.width, CellWidth::Two);
}

#[test]
fn backspace_does_not_corrupt_wide_char() {
    let mut g = grid(3, 10);
    let _ = g.feed("한".as_bytes());
    let _ = g.feed(b"\x08");
    assert!(g.cursor().col < 2);
}
