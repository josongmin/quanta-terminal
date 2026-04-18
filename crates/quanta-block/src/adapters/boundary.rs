//! `vte`-backed implementation of [`crate::ports::BoundaryDetector`].
//!
//! This is the only place in the block crate that depends on `vte`. All other
//! layers speak in domain types (`BoundaryEvent`, `BoundarySink`) and the port
//! trait.
//!
//! # Byte transparency
//!
//! `vte::Parser::advance` takes bytes (`u8`), not chars. The detector never
//! decodes PTY bytes to `String` on the hot path: only OSC payloads that are
//! advertised as text to the domain (OSC 7 cwd, OSC 133 `D` exit code) are
//! parsed via `std::str::from_utf8`, and those failures are handled as
//! **event-skipped-with-warning** rather than panics (see policy at
//! [`Performer::osc_dispatch`]).

use vte::{Params, Parser, Perform};

use crate::domain::{BoundaryEvent, BoundarySink};
use crate::ports::BoundaryDetector;

/// A stateful, `vte`-backed boundary detector. Feed PTY bytes via
/// [`VteBoundaryDetector::feed`].
pub struct VteBoundaryDetector {
    parser: Parser,
}

impl std::fmt::Debug for VteBoundaryDetector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VteBoundaryDetector").finish()
    }
}

impl Default for VteBoundaryDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl VteBoundaryDetector {
    #[must_use]
    pub fn new() -> Self {
        Self {
            parser: Parser::new(),
        }
    }

    /// Parse `bytes` and emit boundary events into `sink`.
    ///
    /// Kept as an inherent method as well as via the `BoundaryDetector` impl so
    /// existing callers don't need the port trait in scope.
    pub fn feed<S: BoundarySink>(&mut self, bytes: &[u8], sink: &mut S) {
        let mut performer = Performer { sink };
        for &b in bytes {
            self.parser.advance(&mut performer, b);
        }
    }
}

impl BoundaryDetector for VteBoundaryDetector {
    fn feed(&mut self, bytes: &[u8], sink: &mut dyn BoundarySink) {
        let mut performer = Performer { sink };
        for &b in bytes {
            self.parser.advance(&mut performer, b);
        }
    }
}

struct Performer<'a, S: BoundarySink + ?Sized> {
    sink: &'a mut S,
}

impl<S: BoundarySink + ?Sized> Perform for Performer<'_, S> {
    fn print(&mut self, _c: char) {}
    fn execute(&mut self, _byte: u8) {}
    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.is_empty() {
            return;
        }
        let head = params[0];
        // OSC 133 — shell integration boundaries.
        if head == b"133" && params.len() >= 2 {
            let sub = params[1];
            if sub.is_empty() {
                return;
            }
            match sub[0] {
                b'A' => self.sink.on_event(BoundaryEvent::PromptStart),
                b'B' => self.sink.on_event(BoundaryEvent::CommandStart),
                b'C' => self.sink.on_event(BoundaryEvent::OutputStart),
                b'D' => {
                    // OSC 133 ; D ; <exit_code>. Exit code is an ASCII decimal.
                    // If bytes are non-UTF-8 (malformed shell integration) we
                    // fall back to `None` rather than panicking.
                    let exit = if params.len() >= 3 {
                        std::str::from_utf8(params[2])
                            .ok()
                            .and_then(|s| s.trim().parse::<i32>().ok())
                    } else {
                        None
                    };
                    self.sink
                        .on_event(BoundaryEvent::CommandDone { exit_code: exit });
                }
                _ => {}
            }
            return;
        }
        // OSC 7 — cwd advertisement. The payload is `file://<host>/<path>`.
        //
        // Malformed-UTF-8 policy: we **skip the event** and leave cwd
        // unchanged. We explicitly do NOT use `String::from_utf8_lossy` here
        // because a cwd that silently replaces bytes with U+FFFD would be
        // wrong for downstream consumers (chdir, breadcrumb UI). The
        // domain-level `BoundaryEvent::CwdAdvertised` carries a plain
        // `String`, so propagating a lossy path would falsify that type
        // contract. Skipping is safe: the next shell prompt typically emits
        // another OSC 7 with correct bytes, or the reducer falls back to
        // `CwdSource::PromptEstimate`.
        //
        // The session actor does not panic on this path because we never
        // emit the event; `handle_boundary` only runs when an event fires.
        //
        // Valid multi-byte UTF-8 (Korean/Japanese/Chinese/emoji paths) passes
        // through unchanged — see `fixtures/boundary/multibyte-osc7-*`.
        if head == b"7" && params.len() >= 2 {
            if let Ok(s) = std::str::from_utf8(params[1]) {
                let cwd = parse_file_url(s).unwrap_or_else(|| s.to_string());
                self.sink.on_event(BoundaryEvent::CwdAdvertised { cwd });
            }
            // else: malformed UTF-8 cwd. Silently drop per docblock above.
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, c: char) {
        // DEC private mode: CSI ? <num> h|l is signaled via `?` in intermediates.
        if !intermediates.contains(&b'?') {
            return;
        }
        if c != 'h' && c != 'l' {
            return;
        }
        for p in params {
            if let Some(&n) = p.first() {
                match (n, c) {
                    (1049 | 1047 | 47, 'h') => {
                        self.sink.on_event(BoundaryEvent::AltScreenEntered);
                    }
                    (1049 | 1047 | 47, 'l') => {
                        self.sink.on_event(BoundaryEvent::AltScreenExited);
                    }
                    _ => {}
                }
            }
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

/// Very small `file://host/path` parser — we accept both `file:///path` and
/// `file://host/path` forms and return the path portion.
fn parse_file_url(s: &str) -> Option<String> {
    let rest = s.strip_prefix("file://")?;
    // Skip host if any (up to the first '/').
    rest.find('/').map(|idx| rest[idx..].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(bytes: &[u8]) -> Vec<BoundaryEvent> {
        let mut det = VteBoundaryDetector::new();
        let mut sink: Vec<BoundaryEvent> = Vec::new();
        det.feed(bytes, &mut sink);
        sink
    }

    #[test]
    fn detects_osc133_a() {
        let input = b"\x1b]133;A\x1b\\";
        assert_eq!(drive(input), vec![BoundaryEvent::PromptStart]);
    }

    #[test]
    fn detects_osc133_b_and_c() {
        let input = b"\x1b]133;B\x1b\\\x1b]133;C\x1b\\";
        assert_eq!(
            drive(input),
            vec![BoundaryEvent::CommandStart, BoundaryEvent::OutputStart]
        );
    }

    #[test]
    fn detects_osc133_d_with_exit_code() {
        let input = b"\x1b]133;D;42\x1b\\";
        assert_eq!(
            drive(input),
            vec![BoundaryEvent::CommandDone {
                exit_code: Some(42)
            }]
        );
    }

    #[test]
    fn detects_osc133_d_without_exit_code() {
        let input = b"\x1b]133;D\x1b\\";
        assert_eq!(
            drive(input),
            vec![BoundaryEvent::CommandDone { exit_code: None }]
        );
    }

    #[test]
    fn detects_osc7_cwd() {
        let input = b"\x1b]7;file://localhost/tmp/x\x1b\\";
        assert_eq!(
            drive(input),
            vec![BoundaryEvent::CwdAdvertised {
                cwd: "/tmp/x".into()
            }]
        );
    }

    #[test]
    fn detects_alt_screen_enter_and_exit() {
        let enter = b"\x1b[?1049h";
        let exit = b"\x1b[?1049l";
        assert_eq!(drive(enter), vec![BoundaryEvent::AltScreenEntered]);
        assert_eq!(drive(exit), vec![BoundaryEvent::AltScreenExited]);
    }

    #[test]
    fn detects_legacy_alt_screen_variants() {
        let enter = b"\x1b[?47h";
        let exit = b"\x1b[?1047l";
        assert_eq!(drive(enter), vec![BoundaryEvent::AltScreenEntered]);
        assert_eq!(drive(exit), vec![BoundaryEvent::AltScreenExited]);
    }

    #[test]
    fn plain_output_emits_no_events() {
        let input = b"hello world\n";
        assert_eq!(drive(input), vec![]);
    }

    #[test]
    fn boundary_detector_port_delegates_to_inherent_feed() {
        // Exercise the port-trait path to guard against drift between the two impls.
        let mut det: Box<dyn BoundaryDetector> = Box::new(VteBoundaryDetector::new());
        let mut sink: Vec<BoundaryEvent> = Vec::new();
        det.feed(b"\x1b]133;A\x1b\\", &mut sink);
        assert_eq!(sink, vec![BoundaryEvent::PromptStart]);
    }

    #[test]
    fn osc7_with_korean_path_is_emitted_unchanged() {
        // "/tmp/한글" — Korean characters in the path, correctly UTF-8 encoded.
        let mut input: Vec<u8> = b"\x1b]7;file://localhost/tmp/".to_vec();
        // 한 = ED 95 9C, 글 = EA B8 80
        input.extend_from_slice(&[0xED, 0x95, 0x9C, 0xEA, 0xB8, 0x80]);
        input.extend_from_slice(b"\x1b\\");
        let events = drive(&input);
        assert_eq!(
            events,
            vec![BoundaryEvent::CwdAdvertised {
                cwd: "/tmp/한글".to_string(),
            }]
        );
    }

    #[test]
    fn osc7_with_emoji_path_is_emitted_unchanged() {
        // "/tmp/👋" — 4-byte UTF-8 sequence (emoji).
        let mut input: Vec<u8> = b"\x1b]7;file://localhost/tmp/".to_vec();
        input.extend_from_slice(&[0xF0, 0x9F, 0x91, 0x8B]);
        input.extend_from_slice(b"\x1b\\");
        let events = drive(&input);
        assert_eq!(
            events,
            vec![BoundaryEvent::CwdAdvertised {
                cwd: "/tmp/👋".to_string(),
            }]
        );
    }

    #[test]
    fn osc7_with_malformed_utf8_is_silently_skipped() {
        // 0xFF is not a valid UTF-8 leading byte in any context; the detector
        // must NOT panic, and it must NOT emit a CwdAdvertised with replacement
        // chars. Per policy: skip.
        let mut input: Vec<u8> = b"\x1b]7;file://localhost/tmp/".to_vec();
        input.extend_from_slice(&[0xFF, 0xFE]);
        input.extend_from_slice(b"\x1b\\");
        let events = drive(&input);
        assert_eq!(events, vec![], "malformed OSC 7 must produce no events");
    }

    #[test]
    fn cjk_output_across_chunk_boundaries_stays_byte_transparent() {
        // Plain non-boundary output containing Korean "한글" split mid-codepoint
        // must produce no events, but also must not crash the detector. This
        // proves the detector is byte-independent.
        let mut det = VteBoundaryDetector::new();
        let mut sink: Vec<BoundaryEvent> = Vec::new();
        // 한 = ED 95 9C  →  split as [ED 95] [9C]
        det.feed(&[0xED, 0x95], &mut sink);
        det.feed(&[0x9C], &mut sink);
        // 글 = EA B8 80  →  split as [EA] [B8 80]
        det.feed(&[0xEA], &mut sink);
        det.feed(&[0xB8, 0x80], &mut sink);
        assert_eq!(sink, vec![]);
    }
}
