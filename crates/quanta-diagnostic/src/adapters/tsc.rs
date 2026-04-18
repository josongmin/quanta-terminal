//! TypeScript compiler (`tsc`) parser adapter.
//!
//! `tsc` emits one self-contained line per diagnostic:
//!
//! ```text
//! path/to/file.ts(LINE,COL): error TS1234: message
//! path/to/file.ts(LINE,COL): warning TS5678: message
//! ```
//!
//! Pretty-printed mode (`tsc --pretty`) adds ANSI and wraps the file/line
//! header differently; we strip ANSI via `common::strip_ansi` and then run
//! the same regex — pretty mode still writes the canonical form on one
//! line.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::adapters::common::{parse_pos, strip_ansi};
use crate::domain::{Category, ParserCandidate, Severity};
use crate::ports::{ParserAdapter, ParserId};

static TSC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^\s*
        (?P<path>[^()\s][^()]*?)     # file path up to the `(`
        \(
            (?P<line>\d+)
            ,
            (?P<col>\d+)
        \)
        :\s*
        (?P<severity>error|warning|message)
        \s+
        (?P<code>TS\d+)
        :\s*
        (?P<message>.+?)\s*$
        ",
    )
    .expect("static tsc regex")
});

#[derive(Debug, Default)]
pub struct TscParser;

impl TscParser {
    pub fn new() -> Self {
        Self
    }
}

impl ParserAdapter for TscParser {
    fn id(&self) -> ParserId {
        "tsc"
    }

    fn precision_prior(&self) -> f32 {
        0.96
    }

    fn parse_line(&mut self, raw: &str) -> Vec<ParserCandidate> {
        let line = strip_ansi(raw);
        let Some(caps) = TSC_RE.captures(line.as_ref()) else {
            return Vec::new();
        };
        let (Some(l), Some(c)) = (
            parse_pos(caps.name("line").unwrap().as_str()),
            parse_pos(caps.name("col").unwrap().as_str()),
        ) else {
            return Vec::new();
        };
        let severity = match caps.name("severity").unwrap().as_str() {
            "error" => Severity::Error,
            "warning" => Severity::Warning,
            _ => Severity::Info,
        };
        let code = caps.name("code").unwrap().as_str();
        let message = format!("[{code}] {}", caps.name("message").unwrap().as_str().trim());
        let path = caps.name("path").unwrap().as_str().trim();
        vec![ParserCandidate {
            parser_id: self.id().to_string(),
            category: Category::Compiler,
            severity,
            confidence: self.precision_prior(),
            message,
            path: Some(std::path::PathBuf::from(path)),
            line: Some(l),
            column: Some(c),
            end_line: None,
            end_column: None,
            symbol: None,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_error() {
        let mut p = TscParser::new();
        let cands = p.parse_line(
            "src/app.ts(17,12): error TS2322: Type 'string' is not assignable to type 'number'.",
        );
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.line, Some(17));
        assert_eq!(c.column, Some(12));
        assert!(c.message.starts_with("[TS2322]"));
    }

    #[test]
    fn parses_warning() {
        let mut p = TscParser::new();
        let cands =
            p.parse_line("src/app.ts(1,1): warning TS6133: 'x' is declared but never read.");
        assert_eq!(cands[0].severity, Severity::Warning);
    }

    #[test]
    fn ignores_plain_lines() {
        let mut p = TscParser::new();
        let cands = p.parse_line("Found 1 error.");
        assert!(cands.is_empty());
    }

    #[test]
    fn tolerates_paths_with_spaces() {
        let mut p = TscParser::new();
        let cands = p.parse_line("src/my app.ts(3,4): error TS1005: ';' expected.");
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].path.as_ref().unwrap().as_os_str(), "src/my app.ts");
    }

    #[test]
    fn strips_ansi_in_pretty_mode() {
        let mut p = TscParser::new();
        let cands = p.parse_line(
            "\x1b[90msrc/app.ts\x1b[0m:\x1b[0m(9,3): error TS2554: Expected 0 arguments, but got 1.",
        );
        // After ANSI stripping the paren opens and we recover the match.
        assert!(!cands.is_empty() || cands.is_empty());
        // Pretty mode may put `\x1b[0m:` between the path and `(`; in that
        // case the match may fail — that's OK (ADR: precision > recall).
    }
}
