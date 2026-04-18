//! Python traceback parser.
//!
//! A Python traceback looks like:
//!
//! ```text
//! Traceback (most recent call last):
//!   File "path/to/mod.py", line 42, in function
//!     offending_source_line()
//!   File "/abs/other.py", line 7, in <module>
//!     raise ValueError("bad thing")
//! ValueError: bad thing
//! ```
//!
//! The last `File "…"` frame is the most useful anchor — it is the source
//! location where the exception was raised. Additionally, the final
//! `TypeError: …` / `ValueError: …` line carries the human-readable message.
//!
//! The parser accumulates all `File "…"` frames until it sees the error-class
//! terminator, then emits ONE candidate anchored at the innermost frame. We
//! emit once per traceback to avoid duplicate entries per frame.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::adapters::common::{parse_pos, strip_ansi};
use crate::domain::{Category, ParserCandidate, Severity};
use crate::ports::{ParserAdapter, ParserId};

static FRAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?x)
        ^\s*File\s+
        "(?P<path>[^"]+)"           # double-quoted path, may contain spaces
        ,\s*line\s+
        (?P<line>\d+)
        (?:,\s*in\s+(?P<func>[^\s][^\n]*?))?
        \s*$
        "#,
    )
    .expect("static python frame regex")
});

/// Matches the terminal error-class line: `ExceptionClass: message` where the
/// class is a CamelCase identifier. Relaxed to also accept a bare class
/// without message (`KeyboardInterrupt\n`).
static ERROR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?x)
        ^
        (?P<class>[A-Z][A-Za-z0-9_.]*Error|            # …Error
                  [A-Z][A-Za-z0-9_.]*Exception|        # …Exception
                  [A-Z][A-Za-z0-9_.]*Warning|          # …Warning
                  KeyboardInterrupt|SystemExit|StopIteration|
                  GeneratorExit|AssertionError|Exception|BaseException|
                  ValueError|TypeError|KeyError|IndexError|ImportError|
                  RuntimeError|NotImplementedError|FileNotFoundError|
                  PermissionError|OSError|IOError|NameError|AttributeError|
                  ZeroDivisionError|OverflowError|RecursionError|
                  UnicodeDecodeError|UnicodeEncodeError|LookupError
        )
        (?::\s*(?P<message>.+?))?
        \s*$
        ",
    )
    .expect("static python error-class regex")
});

#[derive(Debug, Clone)]
struct Frame {
    path: String,
    line: u32,
    func: Option<String>,
}

#[derive(Debug, Default)]
pub struct PythonTracebackParser {
    /// `true` once we have seen a `Traceback (…):` header. The parser is
    /// strict: we only collect frames inside a traceback block, so a bare
    /// `File "foo.py", line 1` unrelated to any exception doesn't produce
    /// a spurious diagnostic.
    in_traceback: bool,
    frames: Vec<Frame>,
}

impl PythonTracebackParser {
    pub fn new() -> Self {
        Self::default()
    }

    fn emit(&mut self, message: String) -> Vec<ParserCandidate> {
        let Some(innermost) = self.frames.last().cloned() else {
            self.reset();
            return Vec::new();
        };
        let cand = ParserCandidate {
            parser_id: "python_traceback".to_string(),
            category: Category::Runtime,
            severity: Severity::Error,
            confidence: 0.93,
            message,
            path: Some(std::path::PathBuf::from(innermost.path)),
            line: Some(innermost.line),
            column: None,
            end_line: None,
            end_column: None,
            symbol: innermost.func,
        };
        self.reset();
        vec![cand]
    }

    fn reset(&mut self) {
        self.in_traceback = false;
        self.frames.clear();
    }
}

impl ParserAdapter for PythonTracebackParser {
    fn id(&self) -> ParserId {
        "python_traceback"
    }

    fn precision_prior(&self) -> f32 {
        0.93
    }

    fn parse_line(&mut self, raw: &str) -> Vec<ParserCandidate> {
        let line = strip_ansi(raw);
        let line = line.as_ref();

        // Traceback header — start fresh. "most recent call last" is the
        // common variant; be lenient about the parenthesized hint.
        if line.starts_with("Traceback ") {
            self.reset();
            self.in_traceback = true;
            return Vec::new();
        }

        if !self.in_traceback {
            return Vec::new();
        }

        // File frame — accumulate.
        if let Some(caps) = FRAME_RE.captures(line) {
            let path = caps.name("path").unwrap().as_str().to_string();
            let Some(line_n) = parse_pos(caps.name("line").unwrap().as_str()) else {
                return Vec::new();
            };
            let func = caps.name("func").map(|m| m.as_str().trim().to_string());
            self.frames.push(Frame {
                path,
                line: line_n,
                func,
            });
            return Vec::new();
        }

        // Body/context line inside a frame — ignore.
        if line.starts_with("    ") || line.starts_with("  ") {
            return Vec::new();
        }

        // Error-class terminator — emit and reset.
        if let Some(caps) = ERROR_RE.captures(line) {
            let class = caps.name("class").unwrap().as_str();
            let msg = caps
                .name("message")
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            let message = if msg.is_empty() {
                class.to_string()
            } else {
                format!("{class}: {msg}")
            };
            return self.emit(message);
        }

        // Anything else — assume traceback ended mid-stream (e.g. another
        // program's output interleaved). Drop accumulated state.
        self.reset();
        Vec::new()
    }

    fn flush(&mut self) -> Vec<ParserCandidate> {
        self.reset();
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(p: &mut PythonTracebackParser, text: &str) -> Vec<ParserCandidate> {
        let mut out = Vec::new();
        for line in text.lines() {
            out.extend(p.parse_line(line));
        }
        out
    }

    #[test]
    fn single_frame_emits_one() {
        let mut p = PythonTracebackParser::new();
        let cands = feed(
            &mut p,
            r#"Traceback (most recent call last):
  File "app.py", line 7, in <module>
    main()
ValueError: bad thing
"#,
        );
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.path.as_ref().unwrap().as_os_str(), "app.py");
        assert_eq!(c.line, Some(7));
        assert!(c.message.starts_with("ValueError"));
        assert_eq!(c.symbol.as_deref(), Some("<module>"));
    }

    #[test]
    fn anchors_at_innermost_frame() {
        let mut p = PythonTracebackParser::new();
        let cands = feed(
            &mut p,
            r#"Traceback (most recent call last):
  File "a.py", line 1, in outer
    inner()
  File "b.py", line 99, in inner
    raise RuntimeError("boom")
RuntimeError: boom
"#,
        );
        assert_eq!(cands[0].path.as_ref().unwrap().as_os_str(), "b.py");
        assert_eq!(cands[0].line, Some(99));
    }

    #[test]
    fn no_emit_without_terminator() {
        let mut p = PythonTracebackParser::new();
        let cands = feed(
            &mut p,
            r#"Traceback (most recent call last):
  File "a.py", line 1, in outer
"#,
        );
        assert!(cands.is_empty());
    }

    #[test]
    fn path_with_spaces() {
        let mut p = PythonTracebackParser::new();
        let cands = feed(
            &mut p,
            r#"Traceback (most recent call last):
  File "/Users/me/My Code/app.py", line 3, in main
KeyError: 'missing'
"#,
        );
        assert_eq!(
            cands[0].path.as_ref().unwrap().as_os_str(),
            "/Users/me/My Code/app.py"
        );
    }

    #[test]
    fn bare_file_outside_traceback_ignored() {
        let mut p = PythonTracebackParser::new();
        let cands = p.parse_line(r#"  File "foo.py", line 10, in bar"#);
        assert!(cands.is_empty());
    }
}
