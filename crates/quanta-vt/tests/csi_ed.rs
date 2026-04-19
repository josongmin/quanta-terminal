//! ED / EL tests.

mod common;

use common::grid;

#[test]
fn ed_2_clears_all() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"hello\r\nworld\r\n\x1b[2J");
    let snap = g.snapshot();
    for row in &snap.cells {
        for c in row {
            assert!(c.grapheme.as_str().is_empty());
        }
    }
}

#[test]
fn ed_0_clears_cursor_to_end() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"aaaaa\r\nbbbbb\r\n\x1b[1;3H\x1b[0J");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "a");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "a");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "");
    for c in &snap.cells[1] {
        assert!(c.grapheme.as_str().is_empty());
    }
}

#[test]
fn ed_1_clears_start_to_cursor() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"aaaaa\r\nbbbbb\r\n\x1b[2;3H\x1b[1J");
    let snap = g.snapshot();
    for c in &snap.cells[0] {
        assert!(c.grapheme.as_str().is_empty());
    }
    assert_eq!(snap.cells[1][0].grapheme.as_str(), "");
    assert_eq!(snap.cells[1][1].grapheme.as_str(), "");
    assert_eq!(snap.cells[1][2].grapheme.as_str(), "");
}

#[test]
fn el_0_clears_cursor_to_eol() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"hello\x1b[1;3H\x1b[0K");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "h");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "e");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "");
}

#[test]
fn el_1_clears_bol_to_cursor() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"hello\x1b[1;3H\x1b[1K");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "");
    assert_eq!(snap.cells[0][2].grapheme.as_str(), "");
    assert_eq!(snap.cells[0][3].grapheme.as_str(), "l");
}

#[test]
fn el_2_clears_entire_line() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"hello\x1b[1;3H\x1b[2K");
    let snap = g.snapshot();
    for c in &snap.cells[0] {
        assert!(c.grapheme.as_str().is_empty());
    }
}

#[test]
fn ed_3_emits_clear_scrollback() {
    use quanta_vt::TerminalEvent;
    let mut g = grid(3, 10);
    // First push some content so scrollback has entries.
    for _ in 0..10 {
        let _ = g.feed(b"x\r\n");
    }
    let events = g.feed(b"\x1b[3J");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::ClearScrollback)));
}
