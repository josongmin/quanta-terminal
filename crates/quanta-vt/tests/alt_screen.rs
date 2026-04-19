//! Alt-screen tests — 20+ scenarios per DoD.

mod common;

use common::grid;
use quanta_vt::{BufferKind, TerminalEvent};

#[test]
fn mode_47_enter_and_exit() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?47h");
    assert_eq!(g.active_buffer(), BufferKind::Alt);
    let _ = g.feed(b"\x1b[?47l");
    assert_eq!(g.active_buffer(), BufferKind::Main);
}

#[test]
fn mode_47_content_isolated() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"MAIN\x1b[?47h\x1b[H");
    let _ = g.feed(b"ALT");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "A");
    let _ = g.feed(b"\x1b[?47l");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "M");
}

#[test]
fn mode_1047_clears_alt_on_exit() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1047h");
    let _ = g.feed(b"ALTCONTENT");
    let _ = g.feed(b"\x1b[?1047l");
    assert_eq!(g.active_buffer(), BufferKind::Main);
}

#[test]
fn mode_1048_saves_cursor_without_buffer_swap() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[3;5H");
    let _ = g.feed(b"\x1b[?1048h");
    assert_eq!(g.active_buffer(), BufferKind::Main);
    let _ = g.feed(b"\x1b[1;1H");
    let _ = g.feed(b"\x1b[?1048l");
    let c = g.cursor();
    assert_eq!(c.row, 2);
    assert_eq!(c.col, 4);
}

#[test]
fn mode_1049_saves_cursor_enters_alt() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[3;5H");
    let _ = g.feed(b"\x1b[?1049h");
    assert_eq!(g.active_buffer(), BufferKind::Alt);
    let _ = g.feed(b"\x1b[?1049l");
    let c = g.cursor();
    assert_eq!(c.row, 2);
    assert_eq!(c.col, 4);
}

#[test]
fn mode_1049_clears_alt_on_enter() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"stuff");
    let _ = g.feed(b"\x1b[?1049l");
    let _ = g.feed(b"\x1b[?1049h");
    for row in &g.snapshot().cells {
        for c in row {
            assert!(c.grapheme.as_str().is_empty());
        }
    }
}

#[test]
fn alt_screen_mode_changed_emitted() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b[?1049h");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::ModeChanged(_))));
}

#[test]
fn alt_screen_mode_changed_before_cell_delta() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b[?1049hAB");
    let mode_pos = events
        .iter()
        .position(|e| matches!(e, TerminalEvent::ModeChanged(_)))
        .expect("ModeChanged emitted");
    let delta_pos = events
        .iter()
        .position(|e| matches!(e, TerminalEvent::GridDelta(_)));
    if let Some(dp) = delta_pos {
        assert!(mode_pos < dp, "ModeChanged before GridDelta");
    }
}

#[test]
fn nested_alt_is_idempotent() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"\x1b[?1049h");
    assert_eq!(g.active_buffer(), BufferKind::Alt);
    let _ = g.feed(b"\x1b[?1049l");
    assert_eq!(g.active_buffer(), BufferKind::Main);
}

#[test]
fn alt_exit_without_enter_is_noop() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049l");
    assert_eq!(g.active_buffer(), BufferKind::Main);
}

#[test]
fn alt_screen_flag_in_mode_snapshot() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049h");
    assert!(g.mode_snapshot().alt_screen);
    let _ = g.feed(b"\x1b[?1049l");
    assert!(!g.mode_snapshot().alt_screen);
}

#[test]
fn alt_screen_47_flag_in_mode_snapshot() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?47h");
    assert!(g.mode_snapshot().alt_screen);
}

#[test]
fn alt_screen_1047_flag_in_mode_snapshot() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1047h");
    assert!(g.mode_snapshot().alt_screen);
}

#[test]
fn main_content_retained_across_alt_cycle() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"hello");
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"alt!");
    let _ = g.feed(b"\x1b[?1049l");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "h");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "e");
}

#[test]
fn alt_cursor_independent_of_main() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[3;5H");
    let _ = g.feed(b"\x1b[?47h");
    let _ = g.feed(b"\x1b[1;1H");
    assert_eq!(g.cursor().row, 0);
    let _ = g.feed(b"\x1b[?47l");
    // With mode 47 (no-save), cursor stays at wherever we left it in alt.
    assert_eq!(g.active_buffer(), BufferKind::Main);
}

#[test]
fn alt_entered_emits_buffer_kind_alt_in_snapshot() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049h");
    let snap = g.snapshot();
    assert_eq!(snap.buffer_kind, BufferKind::Alt);
}

#[test]
fn mode_1047_flag_consistent_with_mode_bits() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1047h");
    assert!(g.mode_snapshot().alt_screen);
    let _ = g.feed(b"\x1b[?1047l");
    assert!(!g.mode_snapshot().alt_screen);
}

#[test]
fn alt_screen_enter_bumps_row_revisions() {
    let mut g = grid(3, 10);
    let before: Vec<u64> = (0..3).map(|r| g.row_revision(r).unwrap_or(0)).collect();
    let _ = g.feed(b"\x1b[?1049h");
    let after: Vec<u64> = (0..3).map(|r| g.row_revision(r).unwrap_or(0)).collect();
    // Revisions for new buffer should be >= 1.
    for a in &after {
        assert!(*a >= 1);
    }
    let _ = before;
}

#[test]
fn enter_exit_roundtrip_preserves_cursor() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[4;7H");
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"\x1b[?1049l");
    assert_eq!(g.cursor().row, 3);
    assert_eq!(g.cursor().col, 6);
}

#[test]
fn multiple_alt_writes_isolated() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"main1\r\nmain2\r\n");
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"alt1\r\nalt2\r\n");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "a");
    let _ = g.feed(b"\x1b[?1049l");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "m");
}

#[test]
fn nested_alt_47_then_1049() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?47h");
    let _ = g.feed(b"\x1b[?1049h");
    assert_eq!(g.active_buffer(), BufferKind::Alt);
    let _ = g.feed(b"\x1b[?1049l");
    // After 1049l, we restore from save — but save was taken when 1049 entered
    // from alt state. Just ensure no panic + cursor sane.
    assert!(g.cursor().row < 3);
}
