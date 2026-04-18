//! Shared helpers used by every Tier-1 parser adapter.
//!
//! Keep this file small: it is the only place adapters are allowed to share
//! logic, so each helper is general-purpose and well-tested.

use once_cell::sync::Lazy;
use regex::Regex;

/// ANSI SGR / CSI escape remover.
///
/// Compiler output seen through a PTY often carries color codes. The parsers
/// are regex-based on plain text, so we strip escapes at the adapter boundary
/// rather than inside each parser's own regex. Keep the pattern narrow: it
/// only handles the sequences that real compilers emit.
static ANSI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("static ansi regex"));

/// Remove ANSI escape sequences from `line`, returning a borrowed slice when
/// the line is already clean (the common case) or an owned `String` otherwise.
pub(crate) fn strip_ansi(line: &str) -> std::borrow::Cow<'_, str> {
    if line.as_bytes().contains(&0x1b) {
        std::borrow::Cow::Owned(ANSI_RE.replace_all(line, "").into_owned())
    } else {
        std::borrow::Cow::Borrowed(line)
    }
}

/// Parse an optional 1-based number, returning `None` if it doesn't fit in
/// `u32` or the input is empty. Parsers use this for line/column numbers so
/// a pathological `line=9999999999999` doesn't crash the whole pipeline.
pub(crate) fn parse_pos(s: &str) -> Option<u32> {
    s.trim().parse::<u32>().ok().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_known_sgr() {
        let raw = "\x1b[31merror\x1b[0m: boom";
        let out = strip_ansi(raw);
        assert_eq!(out.as_ref(), "error: boom");
    }

    #[test]
    fn leaves_clean_lines_borrowed() {
        let raw = "error[E0425]: cannot find value `foo`";
        let out = strip_ansi(raw);
        assert!(matches!(out, std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn parse_pos_rejects_zero_and_garbage() {
        assert_eq!(parse_pos("3"), Some(3));
        assert_eq!(parse_pos("0"), None);
        assert_eq!(parse_pos(""), None);
        assert_eq!(parse_pos("garbage"), None);
    }
}
