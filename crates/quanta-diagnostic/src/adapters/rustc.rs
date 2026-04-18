//! `rustc` / `cargo` parser adapter.
//!
//! Matches two distinct line shapes that together cover virtually every
//! `cargo build` and `cargo test` diagnostic:
//!
//! 1. **Header** — `error[E0432]: message` or bare `error: message` or
//!    `warning: message`. Starts a new diagnostic.
//! 2. **Span** — ` --> path/to/file.rs:LINE:COL` on the immediately following
//!    line (ignoring any blank lines). Completes the in-flight diagnostic.
//!
//! The parser holds one in-flight diagnostic at a time and emits when the
//! span attaches. If a new header arrives before the span, the old one is
//! discarded (the ADR 0007 "precision over recall" rule: emit only when we
//! have both a message and a location).
//!
//! Test-failure formatting (`cargo test`) is also surfaced: the
//! `---- <name> stdout ----` / `thread '<name>' panicked at path:line:col`
//! pair turns into a `Test`-categorized diagnostic.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::adapters::common::{parse_pos, strip_ansi};
use crate::domain::{Category, ParserCandidate, Severity};
use crate::ports::{ParserAdapter, ParserId};

/// Matches a compiler header line: `error[E0425]: message` or `warning: foo`.
static HEADER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^\s*                                           # optional leading indent
        (?P<severity>error|warning)                    # severity keyword
        (?:\[(?P<code>[A-Z]\d+)\])?                    # optional error code
        :\s*                                           # literal colon + whitespace
        (?P<message>.+?)                               # message (non-greedy)
        \s*$                                           # trailing whitespace only
        ",
    )
    .expect("static rustc header regex")
});

/// Matches a span arrow: ` --> path/to/file.rs:LINE:COL` (rustc) or
/// `  ::: path:LINE:COL` (note spans). Captures file, line, column.
///
/// The path capture is greedy over the "path-colon-line-colon-col" tail so
/// Windows paths like `C:\src\main.rs:3:5` resolve correctly (the leading
/// `C:` is absorbed into the path).
static SPAN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^\s*                         # leading indent
        (?:-->|:::)\s+               # arrow or note marker
        (?P<path>.+?)                # path (greedy-minimal, see next part)
        :(?P<line>\d+)               # :LINE
        :(?P<col>\d+)                # :COL
        \s*$
        ",
    )
    .expect("static rustc span regex")
});

/// Matches a `thread '…' panicked at path:line:col:` line (cargo test).
static PANIC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^thread\s+'(?P<thread>[^']+)'\s+panicked\s+at\s+
        (?P<path>[^:]+)
        :(?P<line>\d+):(?P<col>\d+)
        :?\s*$
        ",
    )
    .expect("static rustc panic regex")
});

/// Matches a `test NAME ... FAILED` summary line (cargo test).
static TEST_FAILED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^test\s+(?P<name>[\w:]+)\s+\.\.\.\s+FAILED\s*$")
        .expect("static rustc test-failed regex")
});

#[derive(Debug)]
struct PendingHeader {
    severity: Severity,
    code: Option<String>,
    message: String,
    /// Number of body lines we will tolerate before the span arrow arrives.
    /// Cargo occasionally interleaves blank lines and labels — 32 is generous
    /// but finite, so a malformed stream can't pin state indefinitely.
    ttl: u16,
}

/// `rustc` / `cargo` parser. One header-span pair per emission.
#[derive(Debug, Default)]
pub struct RustcParser {
    pending: Option<PendingHeader>,
    pending_panic_message: Option<String>,
}

impl RustcParser {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParserAdapter for RustcParser {
    fn id(&self) -> ParserId {
        "rustc"
    }

    fn precision_prior(&self) -> f32 {
        // rustc's output shape is extremely stable: a false positive for the
        // header+span pair is rare in the wild.
        0.95
    }

    fn parse_line(&mut self, raw: &str) -> Vec<ParserCandidate> {
        let line = strip_ansi(raw);
        let line = line.as_ref();

        // --- cargo test: `---- NAME stdout ----` + next panic line. Record
        //     the failing-test name for provenance and keep scanning. The
        //     panic line below is what actually emits the diagnostic.
        if line.starts_with("---- ") && line.ends_with(" stdout ----") {
            // Reset any half-parsed header; a cargo-test panic frame is a
            // new diagnostic context.
            self.pending = None;
        }

        // --- panic line (cargo test). Highest-priority emit: we have path,
        //     line, col, and a message already from the `assertion failed`
        //     or `explicit panic` text that preceded it.
        if let Some(caps) = PANIC_RE.captures(line) {
            let path = caps.name("path").unwrap().as_str().trim();
            let line_n = parse_pos(caps.name("line").unwrap().as_str());
            let col_n = parse_pos(caps.name("col").unwrap().as_str());
            if let (Some(l), Some(c)) = (line_n, col_n) {
                let message = self
                    .pending_panic_message
                    .take()
                    .unwrap_or_else(|| "panicked".to_string());
                return vec![ParserCandidate {
                    parser_id: self.id().to_string(),
                    category: Category::Test,
                    severity: Severity::Error,
                    confidence: self.precision_prior(),
                    message,
                    path: Some(std::path::PathBuf::from(path)),
                    line: Some(l),
                    column: Some(c),
                    end_line: None,
                    end_column: None,
                    symbol: Some(caps.name("thread").unwrap().as_str().to_string()),
                }];
            }
        }
        // Record a panic-adjacent message so the next panic frame can use it.
        if line.contains("assertion ") && line.contains("failed") {
            self.pending_panic_message = Some(line.trim().to_string());
        } else if line.starts_with("panicked at '") {
            // Older panic shape: `panicked at 'msg', file:line:col`.
            self.pending_panic_message = Some(
                line.trim_start_matches("panicked at '")
                    .split("',")
                    .next()
                    .unwrap_or(line)
                    .to_string(),
            );
        }

        // --- `test NAME ... FAILED` — purely a signal; we don't emit from it
        //     directly because we have no path/line. The subsequent panic
        //     line provides those.
        if TEST_FAILED_RE.is_match(line) {
            return Vec::new();
        }

        // --- Header line starts a new in-flight diagnostic.
        if let Some(caps) = HEADER_RE.captures(line) {
            // Skip the `error: aborting due to N previous errors` summary; it
            // carries no location information and would pollute the emit log.
            let message = caps.name("message").unwrap().as_str().trim().to_string();
            if is_summary_message(&message) {
                self.pending = None;
                return Vec::new();
            }
            let severity = match caps.name("severity").unwrap().as_str() {
                "error" => Severity::Error,
                "warning" => Severity::Warning,
                _ => Severity::Info,
            };
            self.pending = Some(PendingHeader {
                severity,
                code: caps.name("code").map(|m| m.as_str().to_string()),
                message,
                ttl: 32,
            });
            return Vec::new();
        }

        // --- Span arrow closes the in-flight diagnostic.
        if let Some(caps) = SPAN_RE.captures(line) {
            if let Some(header) = self.pending.take() {
                let path = caps.name("path").unwrap().as_str().trim();
                let line_n = parse_pos(caps.name("line").unwrap().as_str());
                let col_n = parse_pos(caps.name("col").unwrap().as_str());
                if let (Some(l), Some(c)) = (line_n, col_n) {
                    let mut message = header.message;
                    if let Some(code) = header.code {
                        message = format!("[{code}] {message}");
                    }
                    return vec![ParserCandidate {
                        parser_id: self.id().to_string(),
                        category: Category::Compiler,
                        severity: header.severity,
                        confidence: self.precision_prior(),
                        message,
                        path: Some(std::path::PathBuf::from(path)),
                        line: Some(l),
                        column: Some(c),
                        end_line: None,
                        end_column: None,
                        symbol: None,
                    }];
                }
            }
        }

        // --- Body TTL: drop a stale pending header after enough non-matching
        //     lines so `error: aborting…` followed by unrelated output does
        //     not attach to the next span we see.
        if let Some(p) = self.pending.as_mut() {
            p.ttl = p.ttl.saturating_sub(1);
            if p.ttl == 0 {
                self.pending = None;
            }
        }

        Vec::new()
    }

    fn flush(&mut self) -> Vec<ParserCandidate> {
        self.pending = None;
        self.pending_panic_message = None;
        Vec::new()
    }
}

/// Summary lines carry no location; skip them outright to avoid attaching
/// the next span to the wrong parent header.
fn is_summary_message(msg: &str) -> bool {
    msg.starts_with("aborting due to ")
        || msg.starts_with("could not compile")
        || msg.starts_with("build failed")
        || msg.starts_with("test failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_lines(p: &mut RustcParser, text: &str) -> Vec<ParserCandidate> {
        let mut out = Vec::new();
        for line in text.lines() {
            out.extend(p.parse_line(line));
        }
        out.extend(p.flush());
        out
    }

    #[test]
    fn emits_error_with_code() {
        let mut p = RustcParser::new();
        let cands = feed_lines(
            &mut p,
            "error[E0425]: cannot find value `foo` in this scope\n --> src/main.rs:3:5\n",
        );
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.parser_id, "rustc");
        assert_eq!(c.severity, Severity::Error);
        assert!(c.message.contains("E0425"));
        assert_eq!(c.line, Some(3));
        assert_eq!(c.column, Some(5));
    }

    #[test]
    fn emits_warning_without_code() {
        let mut p = RustcParser::new();
        let cands = feed_lines(
            &mut p,
            "warning: unused variable: `x`\n  --> src/lib.rs:10:9\n",
        );
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].severity, Severity::Warning);
    }

    #[test]
    fn drops_aborting_summary() {
        let mut p = RustcParser::new();
        let cands = feed_lines(&mut p, "error: aborting due to 1 previous error\n");
        assert!(cands.is_empty());
    }

    #[test]
    fn header_without_span_does_not_emit() {
        let mut p = RustcParser::new();
        let cands = feed_lines(&mut p, "error: something\n");
        assert!(cands.is_empty());
    }

    #[test]
    fn cargo_test_panic_emits() {
        let mut p = RustcParser::new();
        let cands = feed_lines(
            &mut p,
            "assertion `left == right` failed\nthread 'my::test' panicked at src/tests/it.rs:42:9:\n",
        );
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.category, Category::Test);
        assert_eq!(c.line, Some(42));
        assert_eq!(c.symbol.as_deref(), Some("my::test"));
    }

    #[test]
    fn ansi_escapes_are_stripped() {
        let mut p = RustcParser::new();
        let cands = feed_lines(
            &mut p,
            "\x1b[31merror[E0308]\x1b[0m: mismatched types\n --> src/lib.rs:7:1\n",
        );
        assert_eq!(cands.len(), 1);
        assert!(cands[0].message.contains("E0308"));
    }

    #[test]
    fn stale_header_times_out() {
        let mut p = RustcParser::new();
        p.parse_line("error: orphan");
        // Feed a lot of noise to blow through the TTL.
        for _ in 0..40 {
            p.parse_line("   some unrelated note");
        }
        // A fresh span should NOT attach to the orphaned header.
        let cands = p.parse_line(" --> src/other.rs:1:1");
        assert!(cands.is_empty());
    }
}
