//! `vte`-backed implementation of [`crate::ports::BoundaryDetector`].
//!
//! This is the only place in the block crate that depends on `vte`. All other
//! layers speak in domain types (`BoundaryEvent`, `BoundarySink`) and the port
//! trait.

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
                    // OSC 133 ; D ; <exit_code>
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
        // OSC 7 — cwd advertisement.
        if head == b"7" && params.len() >= 2 {
            if let Ok(s) = std::str::from_utf8(params[1]) {
                let cwd = parse_file_url(s).unwrap_or_else(|| s.to_string());
                self.sink.on_event(BoundaryEvent::CwdAdvertised { cwd });
            }
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
}
