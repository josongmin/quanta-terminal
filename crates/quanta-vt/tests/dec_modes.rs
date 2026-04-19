//! One test per v1 DEC mode (epic-B §5).

mod common;

use common::grid;
use quanta_vt::{DecMode, TerminalEvent};

fn snapshot_mode_changed(events: &[TerminalEvent]) -> Option<Vec<DecMode>> {
    events.iter().find_map(|e| match e {
        TerminalEvent::ModeChanged(p) => Some(p.changed.clone()),
        _ => None,
    })
}

#[test]
fn dec_mode_1_cursor_key_app() {
    let mut g = grid(3, 10);
    let out = g.feed(b"\x1b[?1h");
    let c = snapshot_mode_changed(&out).expect("ModeChanged");
    assert!(c.contains(&DecMode::CursorKey));
    assert!(g.mode_snapshot().cursor_key_app);
}

#[test]
fn dec_mode_6_origin() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?6h");
    assert!(g.mode_snapshot().origin);
}

#[test]
fn dec_mode_7_autowrap() {
    let mut g = grid(3, 10);
    assert!(g.mode_snapshot().auto_wrap);
    let _ = g.feed(b"\x1b[?7l");
    assert!(!g.mode_snapshot().auto_wrap);
    let _ = g.feed(b"\x1b[?7h");
    assert!(g.mode_snapshot().auto_wrap);
}

#[test]
fn dec_mode_9_x10_mouse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?9h");
    assert_eq!(
        g.mode_snapshot().mouse_protocol,
        quanta_vt::MouseProtocol::X10,
    );
}

#[test]
fn dec_mode_25_cursor_visible() {
    let mut g = grid(3, 10);
    assert!(g.cursor().visible);
    let _ = g.feed(b"\x1b[?25l");
    assert!(!g.cursor().visible);
    let _ = g.feed(b"\x1b[?25h");
    assert!(g.cursor().visible);
}

#[test]
fn dec_mode_45_reverse_wrap() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?45h");
    let c = snapshot_mode_changed(&g.feed(b"\x1b[?45l")).expect("ModeChanged");
    assert!(c.contains(&DecMode::ReverseWrap));
}

#[test]
fn dec_mode_47_alt_buffer() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?47h");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Alt);
    let _ = g.feed(b"\x1b[?47l");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Main);
}

#[test]
fn dec_mode_1000_button_mouse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1000h");
    assert_eq!(
        g.mode_snapshot().mouse_protocol,
        quanta_vt::MouseProtocol::Button,
    );
}

#[test]
fn dec_mode_1002_drag_mouse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1002h");
    assert_eq!(
        g.mode_snapshot().mouse_protocol,
        quanta_vt::MouseProtocol::Drag,
    );
}

#[test]
fn dec_mode_1003_any_mouse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1003h");
    assert_eq!(
        g.mode_snapshot().mouse_protocol,
        quanta_vt::MouseProtocol::Any,
    );
}

#[test]
fn dec_mode_1004_focus_report() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1004h");
    assert!(g.mode_snapshot().focus_report);
}

#[test]
fn dec_mode_1006_sgr_mouse() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1006h");
    assert_eq!(
        g.mode_snapshot().mouse_encoding,
        quanta_vt::MouseEncoding::Sgr,
    );
}

#[test]
fn dec_mode_1047_alt_with_clear_on_exit() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1047h");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Alt);
    let _ = g.feed(b"on alt");
    let _ = g.feed(b"\x1b[?1047l");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Main);
}

#[test]
fn dec_mode_1048_save_cursor() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[3;5H");
    let _ = g.feed(b"\x1b[?1048h"); // save
    let _ = g.feed(b"\x1b[1;1H");
    let _ = g.feed(b"\x1b[?1048l"); // restore
    let c = g.cursor();
    assert_eq!(c.row, 2);
    assert_eq!(c.col, 4);
}

#[test]
fn dec_mode_1049_alt_screen_full() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?1049h");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Alt);
    let _ = g.feed(b"\x1b[?1049l");
    assert_eq!(g.active_buffer(), quanta_vt::BufferKind::Main);
}

#[test]
fn dec_mode_2004_bracketed_paste() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b[?2004h");
    assert!(g.mode_snapshot().bracketed_paste);
    let _ = g.feed(b"\x1b[?2004l");
    assert!(!g.mode_snapshot().bracketed_paste);
}

#[test]
fn dec_mode_2026_sync_update() {
    let mut g = grid(3, 10);
    let out = g.feed(b"\x1b[?2026h");
    assert!(g.mode_snapshot().sync_update);
    assert!(out.iter().any(|e| matches!(
        e,
        TerminalEvent::SynchronizedUpdate(quanta_vt::SyncUpdatePayload::Begin)
    )));
    let out = g.feed(b"\x1b[?2026l");
    assert!(out.iter().any(|e| matches!(
        e,
        TerminalEvent::SynchronizedUpdate(quanta_vt::SyncUpdatePayload::End)
    )));
}

#[test]
fn unknown_dec_mode_emits_unknown_event() {
    let mut g = grid(3, 10);
    let out = g.feed(b"\x1b[?9999h");
    assert!(out.iter().any(|e| matches!(
        e,
        TerminalEvent::UnknownDecMode {
            code: 9999,
            set: true
        }
    )));
}
