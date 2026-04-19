#![allow(clippy::needless_raw_string_hashes)]
//! `check-key-event-encoder-layer` — enforces RFC 0001 invariant **I-6**:
//! `KeyboardEvent` → encoder → bytes. Never browser → bridge → PTY
//! directly.
//!
//! # Heuristic
//!
//! Fully proving "no KeyboardEvent reaches the bridge without encoding"
//! requires a flow-sensitive analysis. That is out of scope for a
//! grep-style CI rule; instead we use a conservative textual
//! heuristic:
//!
//! A TypeScript file under `packages/ui/src/**` is flagged if **both**
//! of the following are true:
//!
//! 1. It references `KeyboardEvent` (type annotation, parameter type,
//!    or handler).
//! 2. It calls `bridge.write(` (or an obvious variant).
//! 3. It does **not** import anything from
//!    `packages/ui/src/features/input/`.
//!
//! The logic is: if your file both holds a `KeyboardEvent` and talks
//! to the bridge directly, the encoder module ought to sit between
//! them. If you import from `features/input/`, you are either the
//! encoder itself or a legitimate consumer of its encoded output.
//!
//! False positives are possible (a file that logs keyboard events
//! and separately writes unrelated bytes to the bridge). The pragma
//! escape below handles those:
//!
//! ```ts
//! // allow-direct-write: unrelated heartbeat, not key input
//! bridge.write(heartbeatBytes);
//! ```
//!
//! The pragma applies to the **next** line.
//!
//! # Status
//!
//! Until the encoder module lands (EPIC-E), any file matching the
//! pattern is a genuine invariant break. After EPIC-E, the allowlist
//! path (`features/input/`) becomes the "I've been through the
//! encoder" signal.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use walkdir::WalkDir;

const UI_ROOT: &str = "packages/ui/src";
const ENCODER_MODULE_PATH: &str = "features/input";
const SCAN_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];
const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "generated",
    "__generated__",
];

/// Patterns indicating a file holds a `KeyboardEvent`. Substring match;
/// false positive surface is limited because `KeyboardEvent` is the
/// canonical DOM interface name and rarely appears elsewhere.
const KEYBOARD_EVENT_MARKERS: &[&str] = &["KeyboardEvent"];

/// Patterns that indicate a direct bridge write.
const BRIDGE_WRITE_MARKERS: &[&str] = &["bridge.write(", "bridge.send(", "this.bridge.write("];

/// Pragma that suppresses a single violation. Applies to the next line.
const ALLOW_PRAGMA: &str = "// allow-direct-write:";

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
                println!("check-key-event-encoder-layer --root <repo-root>");
                std::process::exit(0);
            }
            other => {
                eprintln!("check-key-event-encoder-layer: unknown argument: {other}");
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
            eprintln!("check-key-event-encoder-layer: {n} violation(s) of invariant I-6.");
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("check-key-event-encoder-layer: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path) -> Result<usize> {
    let ui_root = root.join(UI_ROOT);
    if !ui_root.exists() {
        println!("check-key-event-encoder-layer: {UI_ROOT} absent — skipping.");
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
        let rel = path.strip_prefix(root).unwrap_or(path);

        // Skip the encoder module itself — by definition it talks to
        // the bridge after processing a KeyboardEvent.
        if rel.to_string_lossy().contains(ENCODER_MODULE_PATH) {
            continue;
        }

        for hit in scan_text(&text) {
            if has_allow_pragma_above(&text, hit.line) {
                continue;
            }
            violations += 1;
            eprintln!(
                "check-key-event-encoder-layer: {}:{}: {} (I-6)",
                rel.display(),
                hit.line,
                hit.pattern
            );
        }
    }

    println!("check-key-event-encoder-layer: scanned {scanned} file(s); {violations} violation(s)",);
    Ok(violations)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub line: usize,
    pub pattern: String,
}

/// Return violation-hits for a file's text. A file is only flagged
/// when it both references `KeyboardEvent` AND calls a bridge write
/// AND does not import from the encoder module.
pub fn scan_text(text: &str) -> Vec<Hit> {
    let mentions_kbd = KEYBOARD_EVENT_MARKERS
        .iter()
        .any(|m| contains_non_comment(text, m));
    if !mentions_kbd {
        return Vec::new();
    }
    let imports_encoder = text.contains(ENCODER_MODULE_PATH);
    if imports_encoder {
        return Vec::new();
    }

    let mut hits = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line_no = i + 1;
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        for marker in BRIDGE_WRITE_MARKERS {
            if line.contains(marker) {
                hits.push(Hit {
                    line: line_no,
                    pattern: format!(
                        "KeyboardEvent + direct `{marker}...)` without encoder import"
                    ),
                });
            }
        }
    }
    hits
}

/// True iff `text` contains `needle` on a non-comment line.
fn contains_non_comment(text: &str, needle: &str) -> bool {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        if line.contains(needle) {
            return true;
        }
    }
    false
}

pub fn has_allow_pragma_above(text: &str, line_no: usize) -> bool {
    if line_no <= 1 {
        return false;
    }
    let target_zero_based = line_no.saturating_sub(2);
    text.lines()
        .nth(target_zero_based)
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
    fn file_without_keyboard_event_passes() {
        let src = "bridge.write(someBytes);\n";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn file_without_bridge_write_passes() {
        let src = "function handle(e: KeyboardEvent) { console.log(e); }\n";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn keyboard_event_plus_direct_write_fails() {
        let src = "function handle(e: KeyboardEvent) { bridge.write(new Uint8Array([65])); }\n";
        let hits = scan_text(src);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn keyboard_event_with_encoder_import_passes() {
        let src = r#"
            import { encode } from '../features/input/KeyEncoder';
            function handle(e: KeyboardEvent) {
                bridge.write(encode(e));
            }
        "#;
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn pragma_suppresses_direct_write() {
        let src = r#"
function handle(e: KeyboardEvent) {
    // allow-direct-write: heartbeat bytes unrelated to this KeyboardEvent
    bridge.write(new Uint8Array([0]));
}
"#;
        let hits = scan_text(src);
        // The hits list is produced ignoring pragma; simulate the
        // outer filter the binary applies.
        let suppressed: Vec<_> = hits
            .iter()
            .filter(|h| !has_allow_pragma_above(src, h.line))
            .collect();
        assert!(
            suppressed.is_empty(),
            "pragma must suppress the bridge.write hit, got {hits:?}"
        );
    }

    #[test]
    fn comment_mentions_of_keyboard_event_do_not_trip_the_rule() {
        let src = "// handles KeyboardEvent somewhere else\nbridge.write(stuff);\n";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn this_dot_bridge_write_is_detected() {
        let src = "class X { handle(e: KeyboardEvent) { this.bridge.write(buf); } }\n";
        let hits = scan_text(src);
        assert!(
            !hits.is_empty(),
            "this.bridge.write should be flagged; got {hits:?}"
        );
    }
}
