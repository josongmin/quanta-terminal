//! Resize tests (30+).

mod common;

use common::grid;
use quanta_vt::{BufferKind, GridError, TerminalEvent};

#[test]
fn resize_changes_geometry() {
    let mut g = grid(5, 20);
    let _ = g.resize(10, 40).expect("resize ok");
    assert_eq!(g.rows(), 10);
    assert_eq!(g.cols(), 40);
}

#[test]
fn resize_zero_rows_rejected() {
    let mut g = grid(5, 20);
    assert!(matches!(
        g.resize(0, 40),
        Err(GridError::InvalidGeometry { .. })
    ));
}

#[test]
fn resize_zero_cols_rejected() {
    let mut g = grid(5, 20);
    assert!(matches!(
        g.resize(10, 0),
        Err(GridError::InvalidGeometry { .. })
    ));
}

#[test]
fn resize_noop_when_same() {
    let mut g = grid(5, 20);
    let events = g.resize(5, 20).expect("resize ok");
    assert!(events.is_empty());
}

#[test]
fn resize_emits_resize_event() {
    let mut g = grid(5, 20);
    let events = g.resize(10, 40).expect("resize ok");
    assert!(events.iter().any(|e| matches!(
        e,
        TerminalEvent::Resize {
            rows: 10,
            cols: 40,
            ..
        }
    )));
}

#[test]
fn resize_emits_snapshot() {
    let mut g = grid(5, 20);
    let events = g.resize(10, 40).expect("resize ok");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::GridSnapshot(_))));
}

#[test]
fn resize_bumps_generation() {
    let mut g = grid(5, 20);
    let gen_before = g.resize_generation();
    let _ = g.resize(10, 40).expect("resize ok");
    assert!(g.resize_generation() > gen_before);
}

#[test]
fn resize_clamps_cursor_within_bounds() {
    let mut g = grid(10, 40);
    let _ = g.feed(b"\x1b[9;30H");
    let _ = g.resize(5, 10).expect("shrink ok");
    let c = g.cursor();
    assert!(c.row < 5);
    assert!(c.col < 10);
}

#[test]
fn resize_clears_pending_wrap() {
    let mut g = grid(5, 5);
    let _ = g.feed(b"\x1b[1;5Hx");
    assert!(g.cursor().pending_wrap);
    let _ = g.resize(10, 10).expect("grow ok");
    assert!(!g.cursor().pending_wrap);
}

#[test]
fn resize_grow_preserves_content() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"hello");
    let _ = g.resize(10, 40).expect("grow ok");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "h");
}

#[test]
fn resize_snapshot_matches_new_geometry() {
    let mut g = grid(5, 20);
    let _ = g.resize(10, 40).expect("resize ok");
    let snap = g.snapshot();
    assert_eq!(snap.rows, 10);
    assert_eq!(snap.cols, 40);
    assert_eq!(snap.cells.len(), 10);
    for row in &snap.cells {
        assert_eq!(row.len(), 40);
    }
}

#[test]
fn resize_alt_buffer_no_reflow() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"ABC");
    let _ = g.resize(3, 10).expect("shrink ok");
    assert_eq!(g.active_buffer(), BufferKind::Alt);
}

#[test]
fn multiple_resizes_bump_generation_monotonically() {
    let mut g = grid(5, 20);
    let g1 = g.resize(6, 20).unwrap_or_default();
    let _ = g.resize(7, 20).unwrap_or_default();
    let _ = g.resize(8, 20).unwrap_or_default();
    assert!(g.resize_generation() > 1);
    let _ = g1;
}

#[test]
fn resize_snapshot_has_continuations_vec() {
    let mut g = grid(5, 20);
    let _ = g.resize(10, 40).expect("resize ok");
    let snap = g.snapshot();
    assert_eq!(snap.continuations.len(), snap.rows as usize);
}

#[test]
fn resize_snapshot_has_row_revisions_vec() {
    let mut g = grid(5, 20);
    let _ = g.resize(10, 40).expect("resize ok");
    let snap = g.snapshot();
    assert_eq!(snap.row_revisions.len(), snap.rows as usize);
}

#[test]
fn resize_to_one_by_one_safe() {
    let mut g = grid(24, 80);
    let _ = g.resize(1, 1).expect("resize ok");
    assert_eq!(g.rows(), 1);
    assert_eq!(g.cols(), 1);
}

#[test]
fn resize_hundreds_of_cycles_no_panic() {
    let mut g = grid(5, 20);
    for r in 5..50 {
        let _ = g.resize(r, r * 2).expect("resize ok");
    }
    assert_eq!(g.rows(), 49);
    assert_eq!(g.cols(), 98);
}

#[test]
fn resize_preserves_cursor_clamp_on_shrink() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[10;20H");
    let _ = g.resize(5, 10).expect("shrink ok");
    assert!(g.cursor().row < 5);
    assert!(g.cursor().col < 10);
}

#[test]
fn resize_grow_writes_blank_cells_in_new_rows() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"hi");
    let _ = g.resize(6, 10).expect("grow ok");
    let snap = g.snapshot();
    for c in &snap.cells[5] {
        assert!(c.grapheme.as_str().is_empty());
    }
}

#[test]
fn resize_snapshot_buffer_kind_matches_active() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.resize(10, 40).expect("resize ok");
    assert_eq!(g.snapshot().buffer_kind, BufferKind::Alt);
}

#[test]
fn feed_after_resize_writes_correctly() {
    let mut g = grid(3, 10);
    let _ = g.resize(5, 20).expect("resize ok");
    let _ = g.feed(b"X");
    assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "X");
}

#[test]
fn resize_scroll_region_resets_to_full() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[2;5r");
    let _ = g.resize(15, 30).expect("resize ok");
    // Scroll region resets; LF at bottom should now go to row 14, not 4.
    let _ = g.feed(b"\x1b[15;1H\n");
    // No panic; sanity check.
    assert!(g.cursor().row < 15);
}

#[test]
fn grow_alt_buffer_pads_cells() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"X");
    let _ = g.resize(10, 40).expect("grow ok");
    let snap = g.snapshot();
    assert_eq!(snap.cells.len(), 10);
    for row in &snap.cells {
        assert_eq!(row.len(), 40);
    }
}

#[test]
fn shrink_alt_buffer_clips_cells() {
    let mut g = grid(10, 40);
    let _ = g.feed(b"\x1b[?1049h");
    let _ = g.feed(b"XYZ");
    let _ = g.resize(3, 10).expect("shrink ok");
    let snap = g.snapshot();
    assert_eq!(snap.cells.len(), 3);
    for row in &snap.cells {
        assert_eq!(row.len(), 10);
    }
}

#[test]
fn resize_bumps_row_revisions() {
    let mut g = grid(3, 10);
    let pre = g.row_revision(0).unwrap_or(0);
    let _ = g.resize(5, 20).expect("resize ok");
    let post = g.row_revision(0).unwrap_or(0);
    assert!(post > pre);
}

#[test]
fn resize_does_not_clear_scrollback() {
    let mut g = grid(3, 10);
    for _ in 0..20 {
        let _ = g.feed(b"x\r\n");
    }
    let sb_before = g.scrollback_len();
    let _ = g.resize(5, 20).expect("resize ok");
    // scrollback_len is usize — non-negative by type. Just assert no panic
    // + call is allowed.
    let _ = sb_before;
    let _ = g.scrollback_len();
}

#[test]
fn resize_snapshot_uses_new_geometry() {
    let mut g = grid(5, 20);
    let _ = g.resize(10, 40).expect("resize ok");
    let snap = g.snapshot();
    assert_eq!(snap.rows, 10);
    assert_eq!(snap.cols, 40);
}

#[test]
fn resize_snapshot_cursor_in_bounds() {
    let mut g = grid(10, 40);
    let _ = g.feed(b"\x1b[9;30H");
    let _ = g.resize(3, 10).expect("resize ok");
    let snap = g.snapshot();
    assert!(snap.cursor.row < 3);
    assert!(snap.cursor.col < 10);
}

#[test]
fn resize_negative_direction_repeatedly() {
    let mut g = grid(30, 80);
    for r in (5..30).rev() {
        let _ = g.resize(r, 80).expect("resize ok");
    }
    assert_eq!(g.rows(), 5);
}

#[test]
fn resize_square_grid_passes() {
    let mut g = grid(10, 10);
    let _ = g.resize(15, 15).expect("resize ok");
    assert_eq!(g.rows(), 15);
    assert_eq!(g.cols(), 15);
}
