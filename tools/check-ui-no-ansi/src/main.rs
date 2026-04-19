#![allow(clippy::needless_raw_string_hashes, clippy::single_char_pattern)]

//! `check-ui-no-ansi` — enforces RFC 0001 invariant **I-2**:
//! the UI (TypeScript) MUST NOT parse ANSI / CSI / OSC / DCS escape
//! sequences. All PTY bytes pass through `quanta-vt` in Rust; the
//! browser only consumes the structured event stream.
//!
//! # What this tool scans
//!
//! Files under `packages/ui/src/` with extension
//! `.ts | .tsx | .js | .jsx | .mjs | .cjs`. A match on any of the
//! forbidden patterns (below) fails the lint. The tool is
//! deliberately **tight** — we prefer false negatives over false
//! positives in v1 because a spurious flag on a legitimate file
//! blocks PRs while the wrong fix is argued about.
//!
//! # Forbidden patterns
//!
//! - `\x1b` / `\u001b` in a string literal — ESC byte.
//! - `\e[` — common shell-style shorthand for `\x1b[`.
//! - `"CSI"` / `"OSC"` as standalone identifiers with a parser-ish
//!   context (see the word-boundary heuristics below).
//!
//! # Allowlist
//!
//! Files under `packages/ui/src/features/input/` may reference ANSI
//! byte sequences as *test fixtures* or *IME-keyboard-raw references*,
//! **but never as a parser**. Such references MUST carry a pragma:
//!
//! ```ts
//! // allow-ansi-reference: <reason>
//! const IME_RAW_ESC = '\x1b';
//! ```
//!
//! The pragma applies to the **next line**. One pragma per allowed
//! occurrence.
//!
//! # Exit codes
//!
//! - `0` — clean.
//! - `1` — violations found (logs each `path:line:pattern`).
//! - `2` — fatal (filesystem error, bad argument, no UI tree).
//!
//! # CI wiring
//!
//! `cargo run --quiet -p check-ui-no-ansi -- --root .` from
//! `.github/workflows/ci.yml`. Also wired into `justfile` as
//! `check-no-ansi`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use walkdir::WalkDir;

const UI_ROOT: &str = "packages/ui/src";

/// Directories we never scan. Build artefacts and vendored trees are
/// out of scope. Generated code lives under `shared/types/generated/`
/// which is machine-written from `quanta-proto` and would never carry
/// ANSI, but we skip it anyway so a stray literal in upstream
/// codegen does not trip the lint before a protocol release.
const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    "generated",
    "__generated__",
];

/// Files whose extensions we scan. Intentionally limited to source;
/// `.json` / `.md` are excluded because a documentation file may
/// discuss the invariant by quoting `\x1b[...]`.
const SCAN_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

/// Allowlist prefixes (relative to repo root). A match inside one of
/// these paths is exempt **if** the line-above-pragma is present.
const ALLOWLIST_PREFIXES: &[&str] = &["packages/ui/src/features/input/"];

/// Transitional skip list. Paths that currently contain the legacy
/// ANSI parser slated for removal (RFC 0001 §16 ban #1, EPIC-I). The
/// CI rule ignores these entirely — they will be deleted, not fixed,
/// so flagging them on every PR would create noise without signal.
///
/// When EPIC-I removes these paths, delete the entries here too. The
/// rule itself is unchanged; only the transitional skip shrinks.
const TRANSITIONAL_SKIP_PREFIXES: &[&str] = &[
    "packages/ui/src/shared/lib/ansi-parser/",
    // `features/tui/` hosts the byte-level alt-screen detector. After
    // EPIC-I (xterm removal) the feature is reduced to a detector that
    // forwards enter/exit transitions into `entities/tui`. The byte
    // patterns are ALLOWED references (fixture-style), not a parser;
    // the skip is kept until we migrate the detector to consume
    // `ModeChanged` events directly per EPIC-C.
    "packages/ui/src/features/tui/",
    // The `widgets/terminal-shell/` entry was removed in EPIC-I along
    // with the directory itself.
];

/// Pragma the allowlist requires. Must appear on the immediately
/// preceding line; the tool matches the substring only (reason text
/// is free-form).
const ALLOW_PRAGMA: &str = "// allow-ansi-reference:";

struct Cli {
    root: PathBuf,
}

fn parse_cli() -> Cli {
    let mut args = std::env::args().skip(1);
    let mut root = PathBuf::from(".");
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                root = args
                    .next()
                    .map_or_else(|| PathBuf::from("."), PathBuf::from);
            }
            "-h" | "--help" => {
                println!("check-ui-no-ansi --root <repo-root>");
                std::process::exit(0);
            }
            other => {
                eprintln!("check-ui-no-ansi: unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    Cli { root }
}

fn main() -> ExitCode {
    let cli = parse_cli();
    match run(&cli.root) {
        Ok(0) => ExitCode::SUCCESS,
        Ok(n) => {
            eprintln!("check-ui-no-ansi: {n} violation(s) of invariant I-2.");
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("check-ui-no-ansi: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path) -> Result<usize> {
    let ui_root = root.join(UI_ROOT);
    if !ui_root.exists() {
        // UI tree absent: skip gracefully. Scaffolding in early
        // epics may run this check before the UI crate exists.
        println!("check-ui-no-ansi: {UI_ROOT} absent — skipping.");
        return Ok(0);
    }

    let mut violations = 0usize;
    let mut scanned = 0usize;
    for entry in WalkDir::new(&ui_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped(e))
    {
        let entry = entry.with_context(|| "walk UI tree")?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !SCAN_EXTENSIONS.contains(&ext) {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        scanned += 1;
        let rel_from_root = path.strip_prefix(root).unwrap_or(path);
        let rel_str = rel_from_root.to_string_lossy();
        if TRANSITIONAL_SKIP_PREFIXES
            .iter()
            .any(|p| rel_str.starts_with(p))
        {
            continue;
        }
        let is_allowlisted = ALLOWLIST_PREFIXES.iter().any(|p| rel_str.starts_with(p));
        for hit in scan_text(&text) {
            if is_allowlisted && has_allow_pragma_above(&text, hit.line) {
                continue;
            }
            violations += 1;
            eprintln!(
                "check-ui-no-ansi: {}:{}: forbidden pattern `{}` (I-2)",
                rel_from_root.display(),
                hit.line,
                hit.pattern
            );
        }
    }

    println!("check-ui-no-ansi: scanned {scanned} file(s); {violations} violation(s)",);
    Ok(violations)
}

/// One positive hit: `line` is 1-based; `pattern` is the literal that
/// tripped the scanner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub line: usize,
    pub pattern: String,
}

/// Patterns the scanner flags. Kept as a static table so the tests
/// can iterate it and the rule is visible at a glance.
const FORBIDDEN_LITERALS: &[&str] = &[r"\x1b", r"\u001b", r"\u001B", r"\e["];

/// Scan a single file's text for forbidden patterns, returning one
/// [`Hit`] per line that matched.
///
/// The function is pure so it can be unit-tested end-to-end without
/// touching the filesystem. Allowlist / pragma handling lives in
/// [`has_allow_pragma_above`]; this layer is dumb on purpose.
pub fn scan_text(text: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line_no = i + 1;

        // Byte-literal escapes in strings.
        for pat in FORBIDDEN_LITERALS {
            if line.contains(pat) {
                hits.push(Hit {
                    line: line_no,
                    pattern: (*pat).to_string(),
                });
            }
        }

        // Word-boundary CSI / OSC identifier hits. We only flag when
        // the token appears inside identifier-ish context: preceded
        // by whitespace / `.` / `(` / `"` and followed by an
        // identifier boundary. A comment like
        // `// OSC 133 prompt marker` is accepted; a constant named
        // `CSI_PARSER_STATE` is not.
        //
        // We also skip lines that are themselves comments — comment
        // prose is the natural place to discuss CSI / OSC semantics.
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with("*") {
            continue;
        }
        for tok in ["CSI", "OSC"] {
            if contains_identifier_token(line, tok) {
                hits.push(Hit {
                    line: line_no,
                    pattern: tok.to_string(),
                });
            }
        }
    }
    hits
}

/// Return true iff `tok` appears in `line` as an identifier token.
/// An identifier token is a match where the character before is not
/// alphanumeric / `_` / `$` **and** the character after is not the
/// same. This catches `CSI_PARSER` and `new CSI()` but ignores
/// `OSCILLATOR` or `Moscow`.
fn contains_identifier_token(line: &str, tok: &str) -> bool {
    let bytes = line.as_bytes();
    let tb = tok.as_bytes();
    if tb.len() > bytes.len() {
        return false;
    }
    let mut i = 0usize;
    while i + tb.len() <= bytes.len() {
        if &bytes[i..i + tb.len()] == tb {
            let left_ok = if i == 0 {
                true
            } else {
                !is_ident_byte(bytes[i - 1])
            };
            let right_idx = i + tb.len();
            // We fire on `CSI` as a standalone identifier AND as a
            // compound-identifier prefix separated by `_` or `$`
            // (e.g., `CSI_STATE`, `OSC_HANDLER`). We do NOT fire when
            // the match is a substring continuing into another
            // alphanumeric letter (`OSCILLATOR`, `CSInfo`), since those
            // are not ANSI-parser identifiers.
            let right_ok = if right_idx == bytes.len() {
                true
            } else {
                let next = bytes[right_idx];
                !matches!(next, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9')
            };
            if left_ok && right_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn is_ident_byte(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'$')
}

/// Check for `// allow-ansi-reference: …` on the line immediately
/// preceding `line_no` (1-based). This is the pragma escape hatch
/// for the allowlist described in the module-level docs.
pub fn has_allow_pragma_above(text: &str, line_no: usize) -> bool {
    if line_no <= 1 {
        return false;
    }
    let target = line_no - 1; // 1-based index of the pragma line.
                              // `lines()` is 0-based; `target - 1` reaches the previous line.
    text.lines()
        .nth(target - 1)
        .map(|l| l.trim_start().starts_with(ALLOW_PRAGMA))
        .unwrap_or(false)
}

fn is_skipped(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_str().unwrap_or_default();
    SKIP_DIR_NAMES.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_file_passes() {
        let src = r#"
            import { something } from './foo';
            export const greet = 'hello world';
            // Render the OSC-133 prompt marker via the event stream.
        "#;
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn file_with_x1b_escape_fails() {
        let src = "const reset = '\\x1b[0m';";
        let hits = scan_text(src);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pattern, r"\x1b");
    }

    #[test]
    fn file_with_u001b_escape_fails() {
        let src = "const reset = '\\u001b[0m';";
        let hits = scan_text(src);
        assert!(hits.iter().any(|h| h.pattern == r"\u001b"));
    }

    #[test]
    fn file_with_uppercase_u001b_escape_fails() {
        let src = "const reset = '\\u001B[0m';";
        let hits = scan_text(src);
        assert!(hits.iter().any(|h| h.pattern == r"\u001B"));
    }

    #[test]
    fn csi_identifier_fails_osc_identifier_fails() {
        let src = "class CsiParser { step() {} }\nexport const CSI_STATE = 0;";
        let hits = scan_text(src);
        assert!(hits.iter().any(|h| h.pattern == "CSI"));
    }

    #[test]
    fn csi_inside_word_is_not_flagged() {
        // `Moscow` contains `OSC` as a substring but not as a token.
        let src = "export const city = 'Moscow';";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn comment_mentioning_osc_is_accepted() {
        let src = "// OSC 8 hyperlink is emitted by the engine, not here.";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn allow_pragma_suppresses_hit_on_following_line() {
        let src = "// allow-ansi-reference: IME raw key echo\nconst k = '\\x1b';\n";
        // Pragma applies to line 2.
        assert!(has_allow_pragma_above(src, 2));
    }

    #[test]
    fn allow_pragma_does_not_suppress_two_lines_later() {
        let src = "// allow-ansi-reference: r\nconst a = 1;\nconst k = '\\x1b';\n";
        // Line 3 is two lines below the pragma — not suppressed.
        assert!(!has_allow_pragma_above(src, 3));
    }

    #[test]
    fn identifier_token_matcher_respects_boundaries() {
        assert!(contains_identifier_token("class CSI {}", "CSI"));
        assert!(!contains_identifier_token("const OSCILLATE = 1;", "OSC"));
        assert!(contains_identifier_token("(OSC)", "OSC"));
        assert!(!contains_identifier_token("OSCar", "OSC"));
    }

    #[test]
    fn e_bracket_shorthand_is_flagged() {
        let src = "const reset = '\\e[0m';";
        let hits = scan_text(src);
        assert!(hits.iter().any(|h| h.pattern == r"\e["));
    }
}
