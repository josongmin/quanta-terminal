//! OSC 0/2/4/7/8/10/11/12/52/104/105/133 handler tests.

mod common;

use common::grid;
use quanta_vt::{ClipboardPayload, TerminalEvent};

fn has_title(events: &[TerminalEvent], title: &str) -> bool {
    events
        .iter()
        .any(|e| matches!(e, TerminalEvent::TitleChanged(t) if t == title))
}

#[test]
fn osc_0_title_plain() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]0;MyTitle\x07");
    assert!(has_title(&events, "MyTitle"));
}

#[test]
fn osc_2_title_plain() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]2;WindowTitle\x07");
    assert!(has_title(&events, "WindowTitle"));
}

#[test]
fn osc_2_title_unicode() {
    let mut g = grid(3, 10);
    let events = g.feed("\x1b]2;한글\x07".as_bytes());
    assert!(has_title(&events, "한글"));
}

#[test]
fn osc_0_title_st_terminated() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]0;Title\x1b\\");
    assert!(has_title(&events, "Title"));
}

#[test]
fn osc_7_cwd_plain() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]7;file:///home/user\x07");
    let cwd = events.iter().find_map(|e| match e {
        TerminalEvent::CwdChanged(s) => Some(s.clone()),
        _ => None,
    });
    assert_eq!(cwd.as_deref(), Some("/home/user"));
}

#[test]
fn osc_7_cwd_percent_decode() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]7;file:///home/my%20user\x07");
    let cwd = events.iter().find_map(|e| match e {
        TerminalEvent::CwdChanged(s) => Some(s.clone()),
        _ => None,
    });
    assert_eq!(cwd.as_deref(), Some("/home/my user"));
}

#[test]
fn osc_8_hyperlink_open() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]8;;https://example.com\x07");
    assert!(events.iter().any(
        |e| matches!(e, TerminalEvent::HyperlinkOpened { uri, .. } if uri == "https://example.com")
    ));
}

#[test]
fn osc_8_hyperlink_close() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b]8;;https://example.com\x07");
    let events = g.feed(b"\x1b]8;;\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::HyperlinkClosed { .. })));
}

#[test]
fn osc_52_set_clipboard() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;aGVsbG8=\x07");
    assert!(events.iter().any(|e| matches!(
        e,
        TerminalEvent::ClipboardRequest(ClipboardPayload::Set { .. })
    )));
}

#[test]
fn osc_52_query() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;?\x07");
    assert!(events.iter().any(|e| matches!(
        e,
        TerminalEvent::ClipboardRequest(ClipboardPayload::Query { .. })
    )));
}

#[test]
fn osc_10_passthrough() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]10;#ff0000\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 10, .. })));
}

#[test]
fn osc_11_passthrough() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]11;#00ff00\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 11, .. })));
}

#[test]
fn osc_12_passthrough() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]12;#0000ff\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 12, .. })));
}

#[test]
fn osc_4_palette_passthrough() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]4;5;rgb:ff/00/00\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 4, .. })));
}

#[test]
fn osc_104_reset_palette_entry() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]104;5\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 104, .. })));
}

#[test]
fn osc_105_reset_all_palette() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]105\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 105, .. })));
}

#[test]
fn osc_133_shell_integration_a() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]133;A\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 133, .. })));
}

#[test]
fn osc_133_shell_integration_c() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]133;C\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::OscPassthrough { code: 133, .. })));
}

#[test]
fn osc_unknown_emits_unknown_osc() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]999;foo\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::UnknownOsc { code: 999 })));
}

#[test]
fn osc_multiple_in_one_feed() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]0;Title1\x07\x1b]2;Title2\x07");
    let titles: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TerminalEvent::TitleChanged(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(titles, vec!["Title1", "Title2"]);
}

#[test]
fn bel_emits_bell_requested() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x07");
    assert!(events
        .iter()
        .any(|e| matches!(e, TerminalEvent::BellRequested)));
}
