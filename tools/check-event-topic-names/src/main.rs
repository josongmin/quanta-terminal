//! `check-event-topic-names` — enforces the quanta:// topic registry.
//!
//! Scans every source / doc / TS file under the repo root for `quanta://<...>`
//! string literals and asserts each distinct topic is present in the
//! canonical registry at `crates/quanta-proto/src/topics.rs`. Any new topic
//! must be registered there first; the lint fails otherwise.
//!
//! This is the sibling of `check-hex-imports`: a tiny, dependency-lean
//! correctness gate that fails loudly on typos and undeclared topics.
//!
//! The tool is intentionally textual (regex-free): we walk files and
//! scan bytes for the `quanta://` marker, then read the following run of
//! allowed topic characters. That keeps a fresh clippy-clean binary
//! without any parser dependencies, and in particular covers
//! TypeScript, JSON, Markdown, and Rust call sites uniformly.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use walkdir::WalkDir;

/// Directories we never scan. Built assets and external vendors are out of
/// scope; `target` specifically contains compiled artifacts that would
/// produce false positives from debug strings.
const SKIP_DIR_NAMES: &[&str] = &[
    "target",
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".pnpm-store",
    // `src-tauri/gen` contains generated boilerplate that mirrors topics
    // from the registry; exempting it avoids double-counting without
    // losing coverage (sidecar.rs / ipc.rs still get scanned).
    "gen",
];

/// File extensions we scan. Limited to executable source where a topic
/// literal represents a binding call-site. Prose files (`.md`) are
/// intentionally excluded — counter-example discussions like
/// "use `quanta://pty-data`, not `quanta://pty.data`" must not trip the
/// lint even though the dotted form sits inside backticks that look like
/// string quotes to the scanner.
const SCAN_EXTENSIONS: &[&str] = &["rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "toml"];

/// Path (relative to repo root) of the canonical registry.
const REGISTRY_PATH: &str = "crates/quanta-proto/src/topics.rs";

/// Paths that hold test fixtures which INTENTIONALLY reference unregistered
/// topic strings (to exercise the scanner / lint itself). Skipping these
/// keeps the CI gate green while preserving regression coverage inside
/// the tool's unit tests.
const INTRINSIC_FIXTURE_PATHS: &[&str] = &["tools/check-event-topic-names/src/main.rs"];

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
                println!("check-event-topic-names --root <repo-root>");
                std::process::exit(0);
            }
            other => {
                eprintln!("check-event-topic-names: unknown argument: {other}");
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
            eprintln!("check-event-topic-names: {n} unregistered topic usage(s).");
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("check-event-topic-names: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path) -> Result<usize> {
    // Load the canonical registry. Parsing the file textually avoids a
    // dependency on the `quanta-proto` crate from this CI-only tool —
    // keeping the check a self-contained, fast binary.
    let registry_path = root.join(REGISTRY_PATH);
    let registered = load_registered_topics(&registry_path)
        .with_context(|| format!("load registry from {}", registry_path.display()))?;
    if registered.is_empty() {
        anyhow::bail!(
            "registry at {} is empty; check-event-topic-names would accept anything",
            registry_path.display()
        );
    }

    let mut found: BTreeMap<String, Vec<Location>> = BTreeMap::new();
    let mut scanned_files = 0usize;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped(e))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                eprintln!("check-event-topic-names: warn: {err}");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        // Never scan the registry file itself — every string inside is
        // registered by definition.
        if same_file(path, &registry_path) {
            continue;
        }
        // Skip the tool's own source: it holds test-fixture literals that
        // deliberately include unregistered topics for scanner coverage.
        if INTRINSIC_FIXTURE_PATHS
            .iter()
            .any(|rel| same_file(path, &root.join(rel)))
        {
            continue;
        }
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !SCAN_EXTENSIONS.contains(&ext) {
            continue;
        }
        scanned_files += 1;
        // Binary or permission error: skip quietly.
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        for (line_no, topic) in scan_topics(&text) {
            found.entry(topic).or_default().push(Location {
                file: path.to_path_buf(),
                line: line_no,
            });
        }
    }

    let mut violations = 0usize;
    for (topic, locs) in &found {
        if !registered.contains(topic) {
            violations += locs.len();
            eprintln!("check-event-topic-names: unregistered topic `{topic}`:");
            for loc in locs {
                eprintln!("  {}:{}", loc.file.display(), loc.line);
            }
            eprintln!("  add this topic to {REGISTRY_PATH} (REGISTERED_TOPICS) before using it.",);
        }
    }

    // Also warn if a registered topic is never used anywhere — catches
    // dead entries. This is informational (zero exit impact) so a
    // placeholder topic doesn't fail the gate.
    for t in &registered {
        if !found.contains_key(t) {
            eprintln!("check-event-topic-names: info: registered topic `{t}` has no call sites");
        }
    }

    println!(
        "check-event-topic-names: scanned {scanned_files} file(s); {} registered, {} \
         unique observed, {violations} violation(s)",
        registered.len(),
        found.len(),
    );
    Ok(violations)
}

#[derive(Debug)]
struct Location {
    file: PathBuf,
    line: usize,
}

fn is_skipped(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_str().unwrap_or_default().to_string();
    SKIP_DIR_NAMES.contains(&name.as_str())
}

fn same_file(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .map(|(x, y)| x == y)
        .unwrap_or(false)
}

/// Parse the registry file, pulling out each `"quanta://…"` literal from
/// the `REGISTERED_TOPICS` slice definition. Everything else in the file
/// (test fixtures, doc examples) is ignored so false negatives don't
/// blow up the effective registry.
fn load_registered_topics(path: &Path) -> Result<BTreeSet<String>> {
    let text = fs::read_to_string(path)?;
    // Find the literal block after `REGISTERED_TOPICS`; scan only within
    // the first `&[ … ]` that follows. The exact slice boundary is
    // robust to whitespace, macros, or attribute wrappers.
    let Some(start) = text.find("REGISTERED_TOPICS") else {
        anyhow::bail!("no REGISTERED_TOPICS constant found in registry");
    };
    let after = &text[start..];
    // Anchor on the array-literal opener `= &[` so we don't trip on the
    // `&[&str]` type annotation that appears earlier in the same line.
    let Some(anchor) = after.find("= &[") else {
        anyhow::bail!("no `= &[` after REGISTERED_TOPICS — registry shape changed?");
    };
    let tail = &after[anchor + "= &[".len()..];
    let Some(end) = tail.find(']') else {
        anyhow::bail!("no matching `]` after REGISTERED_TOPICS start");
    };
    let block = &tail[..end];
    Ok(scan_topics(block).into_iter().map(|(_, t)| t).collect())
}

/// Extract every `quanta://…` literal from the text, returning
/// `(line_number, topic_string)` pairs.
///
/// A topic is only collected when it sits inside a quoted string literal
/// (`"…"`, `'…'`, or ``` `…` ```). This deliberately ignores comment prose
/// such as "not `quanta://pty.data`" so the lint does not fail on
/// counter-example documentation. The registry file itself also stores
/// topics inside quoted literals, so the scanner finds them there too.
fn scan_topics(text: &str) -> Vec<(usize, String)> {
    const NEEDLE: &str = "quanta://";
    let mut out = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        // Skip single-line comment lines — doc comments and inline
        // explanations may reference a counter-example topic in
        // backticks, which the quote-heuristic below would otherwise
        // pick up. We intentionally accept the false-negative: a
        // legitimate code use-site on a commented-out line is rare,
        // and the tradeoff is correct for the lint's purpose.
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with('*') {
            continue;
        }
        let bytes = line.as_bytes();
        let mut i = 0usize;
        while let Some(off) = line[i..].find(NEEDLE) {
            let start = i + off;
            let tail = &line[start + NEEDLE.len()..];
            let end = tail
                .bytes()
                .position(|b| !is_topic_char(b))
                .unwrap_or(tail.len());
            if end == 0 {
                i = start + NEEDLE.len();
                continue;
            }
            // Require the topic to be sandwiched between matching quote
            // characters on the same line. We accept the three common
            // quoting forms: "…", '…', and `…`. A false-negative here
            // (topic split across quote forms, raw-string literal, etc.)
            // is preferable to a false-positive on doc prose — the
            // intent is to flag code call sites, not comments.
            let after_end = start + NEEDLE.len() + end;
            let (before, after) = (&bytes[..start], &bytes[after_end..]);
            let opened = before
                .iter()
                .rev()
                .find(|b| matches!(**b, b'"' | b'\'' | b'`'));
            let closed = after.iter().find(|b| matches!(**b, b'"' | b'\'' | b'`'));
            let inside_quotes = matches!((opened, closed), (Some(a), Some(b)) if a == b);
            if !inside_quotes {
                i = after_end;
                continue;
            }
            let topic = format!("{NEEDLE}{}", &tail[..end]);
            out.push((line_no + 1, topic));
            i = after_end;
        }
    }
    out
}

fn is_topic_char(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_extracts_single_topic_from_rust_literal() {
        let t = r#"const X: &str = "quanta://pty-data";"#;
        let out = scan_topics(t);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "quanta://pty-data");
    }

    #[test]
    fn scan_extracts_multiple_topics_across_lines() {
        let t = "first = \"quanta://pty-data\";\nsecond = \"quanta://pty-exit\";\n";
        let topics: Vec<String> = scan_topics(t).into_iter().map(|(_, s)| s).collect();
        assert_eq!(topics, vec!["quanta://pty-data", "quanta://pty-exit"]);
    }

    #[test]
    fn scan_ignores_partial_scheme_match() {
        let t = "not a topic: quanta-colon";
        assert!(scan_topics(t).is_empty());
    }

    #[test]
    fn scan_captures_hyphens_and_digits() {
        let t = "\"quanta://topic-42-foo\"";
        let out = scan_topics(t);
        assert_eq!(out[0].1, "quanta://topic-42-foo");
    }

    #[test]
    fn scan_preserves_dotted_form_so_lint_can_reject_it() {
        // A dotted topic is illegal per Tauri 2; ensure the scanner picks
        // up the full literal instead of silently truncating at the dot.
        let t = "\"quanta://pty.data\"";
        let out = scan_topics(t);
        assert_eq!(out[0].1, "quanta://pty.data");
    }
}
