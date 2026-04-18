//! Node.js stack-trace parser.
//!
//! Node emits stack frames in three canonical shapes:
//!
//! ```text
//!     at functionName (/abs/path/to/file.js:line:col)
//!     at Object.method [as alias] (/abs/path/to/file.js:line:col)
//!     at /abs/path/to/file.js:line:col
//! ```
//!
//! A thrown error typically prints as:
//!
//! ```text
//! ReferenceError: foo is not defined
//!     at Object.<anonymous> (/repo/src/app.js:4:1)
//!     ...
//! ```
//!
//! The parser records the error-class line (`ReferenceError: …`) and then
//! emits one candidate anchored at the FIRST frame under it — that is the
//! site of the failure, and the frames below are noise for the
//! error-to-jump use case.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::adapters::common::{parse_pos, strip_ansi};
use crate::domain::{Category, ParserCandidate, Severity};
use crate::ports::{ParserAdapter, ParserId};

/// Frame with a function name: `    at fn (path:line:col)` — or `path:line`
/// when only a file + line is available.
static FRAME_WITH_FN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^\s*at\s+
        (?P<fn>[^\s].*?)\s+              # function name (may contain spaces)
        \(
            (?P<path>.+?):               # path up to trailing `:L:C)`
            (?P<line>\d+)
            :
            (?P<col>\d+)
        \)
        \s*$
        ",
    )
    .expect("static node frame-with-fn regex")
});

/// Anonymous frame: `    at /abs/path:line:col`.
static FRAME_ANON: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^\s*at\s+
        (?P<path>[^\s()]+?):
        (?P<line>\d+)
        :
        (?P<col>\d+)
        \s*$
        ",
    )
    .expect("static node anon frame regex")
});

/// Leading error-class line: `ReferenceError: foo is not defined`.
///
/// Restricted to well-known JavaScript / Node error class names plus any
/// `*Error` / `*Exception` identifier so custom errors still parse.
static ERROR_CLASS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^
        (?P<class>
            Error|EvalError|RangeError|ReferenceError|SyntaxError|
            TypeError|URIError|AggregateError|AssertionError|
            [A-Z][A-Za-z0-9_]*Error|
            [A-Z][A-Za-z0-9_]*Exception
        )
        :\s*
        (?P<message>.+?)\s*$
        ",
    )
    .expect("static node error-class regex")
});

#[derive(Debug, Default)]
pub struct NodeStackParser {
    /// Pending "ClassName: message" line waiting for its first stack frame.
    pending_message: Option<String>,
}

impl NodeStackParser {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParserAdapter for NodeStackParser {
    fn id(&self) -> ParserId {
        "node_stack"
    }

    fn precision_prior(&self) -> f32 {
        0.90
    }

    fn parse_line(&mut self, raw: &str) -> Vec<ParserCandidate> {
        let line = strip_ansi(raw);
        let line = line.as_ref();

        // Try the error-class header first. If it matches we just stash the
        // message; the frame that follows is the emit trigger.
        if let Some(caps) = ERROR_CLASS.captures(line) {
            let class = caps.name("class").unwrap().as_str();
            let msg = caps.name("message").unwrap().as_str().trim();
            self.pending_message = Some(format!("{class}: {msg}"));
            return Vec::new();
        }

        // Only emit when we have a pending message AND a frame. This is the
        // precision-over-recall trade: a bare stack frame without a preceding
        // thrown error is probably someone printing their own logs.
        let Some(message) = self.pending_message.take() else {
            return Vec::new();
        };

        if let Some(caps) = FRAME_WITH_FN.captures(line) {
            let path = caps.name("path").unwrap().as_str().trim().to_string();
            let line_n = parse_pos(caps.name("line").unwrap().as_str());
            let col_n = parse_pos(caps.name("col").unwrap().as_str());
            if let (Some(l), Some(c)) = (line_n, col_n) {
                let func = caps.name("fn").unwrap().as_str().trim().to_string();
                return vec![ParserCandidate {
                    parser_id: self.id().to_string(),
                    category: Category::Runtime,
                    severity: Severity::Error,
                    confidence: self.precision_prior(),
                    message,
                    path: Some(std::path::PathBuf::from(path)),
                    line: Some(l),
                    column: Some(c),
                    end_line: None,
                    end_column: None,
                    symbol: Some(func),
                }];
            }
        }
        if let Some(caps) = FRAME_ANON.captures(line) {
            let path = caps.name("path").unwrap().as_str().trim().to_string();
            let line_n = parse_pos(caps.name("line").unwrap().as_str());
            let col_n = parse_pos(caps.name("col").unwrap().as_str());
            if let (Some(l), Some(c)) = (line_n, col_n) {
                return vec![ParserCandidate {
                    parser_id: self.id().to_string(),
                    category: Category::Runtime,
                    severity: Severity::Error,
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

        // We consumed the pending message but the next line was not a frame.
        // Drop the pending message — emitting without a location would be a
        // false-positive.
        Vec::new()
    }

    fn flush(&mut self) -> Vec<ParserCandidate> {
        self.pending_message = None;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(p: &mut NodeStackParser, text: &str) -> Vec<ParserCandidate> {
        let mut out = Vec::new();
        for line in text.lines() {
            out.extend(p.parse_line(line));
        }
        out
    }

    #[test]
    fn named_frame_emits() {
        let mut p = NodeStackParser::new();
        let cands = feed(
            &mut p,
            r"ReferenceError: foo is not defined
    at Object.<anonymous> (/repo/src/app.js:4:1)
    at Module._compile (node:internal/modules/cjs/loader:1254:14)
",
        );
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.line, Some(4));
        assert_eq!(c.column, Some(1));
        assert!(c.message.starts_with("ReferenceError"));
        assert_eq!(c.symbol.as_deref(), Some("Object.<anonymous>"));
    }

    #[test]
    fn anon_frame_emits() {
        let mut p = NodeStackParser::new();
        let cands = feed(
            &mut p,
            r"TypeError: Cannot read properties of undefined (reading 'x')
    at /work/app.js:7:22
",
        );
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].line, Some(7));
        assert_eq!(cands[0].column, Some(22));
    }

    #[test]
    fn frame_without_error_is_ignored() {
        let mut p = NodeStackParser::new();
        let cands = p.parse_line("    at foo (/bar/baz.js:1:1)");
        assert!(cands.is_empty());
    }

    #[test]
    fn error_without_frame_is_ignored() {
        let mut p = NodeStackParser::new();
        let c1 = p.parse_line("ReferenceError: x");
        let c2 = p.parse_line("(unrelated output)");
        assert!(c1.is_empty());
        assert!(c2.is_empty());
    }

    #[test]
    fn custom_error_class_parses() {
        let mut p = NodeStackParser::new();
        let cands = feed(
            &mut p,
            r"ValidationError: name is required
    at validate (/app/src/v.js:10:5)
",
        );
        assert_eq!(cands.len(), 1);
    }
}
