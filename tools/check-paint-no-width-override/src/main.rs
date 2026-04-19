//! `check-paint-no-width-override` — enforces RFC 0001 invariant **I-4**:
//! the renderer / paint layer MUST NOT override semantic cell width.
//!
//! The EPIC-A TypeScript width mirror (at `packages/ui/src/shared/lib/width/`)
//! is the **only** source of width for UI code. Importing `unicode-width`
//! directly, or computing widths ad-hoc inside a renderer file, violates
//! the invariant: paint MAY affect pixel placement but MUST NOT produce
//! a different cell width than the engine's.
//!
//! # Scan scope
//!
//! - `packages/ui/src/shared/ui/cell-renderer/**`
//! - `packages/ui/src/widgets/terminal-canvas/**`
//!
//! # Forbidden patterns
//!
//! - `from 'unicode-width'` / `require('unicode-width')` — direct
//!   npm dependency on the npm width package.
//! - `from 'string-width'` / `require('string-width')` — common
//!   alternative.
//! - `charWidth(`, `wcwidth(`, `codePointWidth(` — bare function calls
//!   that look like ad-hoc width recomputation. The CI rule flags
//!   them unless the file imports from `shared/lib/width/`.
//!
//! # Allowlist
//!
//! The only permitted width source is
//! `packages/ui/src/shared/lib/width/`. A renderer file MAY call
//! width helpers if those helpers come from that path — the heuristic
//! is "if you import from `shared/lib/width/`, you are permitted to
//! call width helpers at all".
//!
//! **Pragma:** `// allow-width-override: <reason>` on the line above
//! the call, for unavoidable exceptions.
//!
//! # Status
//!
//! Until EPIC-A lands the TS width mirror, the allowlist path does
//! not exist yet and this rule effectively says "no width imports in
//! renderer files". That is the correct intermediate state — no
//! renderer code can meaningfully depend on a width primitive that
//! doesn't exist. The rule is a stub-safe gate.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use walkdir::WalkDir;

const SCAN_ROOTS: &[&str] = &[
    "packages/ui/src/shared/ui/cell-renderer",
    "packages/ui/src/widgets/terminal-canvas",
];

const SCAN_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

/// The single permitted width source. Files under the scan roots MAY
/// import from this path; calls to width helpers are OK iff the file
/// imports here.
const PERMITTED_WIDTH_SOURCE: &str = "shared/lib/width";

/// Forbidden imports (substring match, any quote flavour).
const FORBIDDEN_IMPORT_FRAGMENTS: &[&str] = &[
    "'unicode-width'",
    "\"unicode-width\"",
    "'string-width'",
    "\"string-width\"",
];

/// Forbidden bare width-function calls. Flagged only when the file
/// does NOT import from `shared/lib/width/`.
const FORBIDDEN_CALLS: &[&str] = &[
    "charWidth(",
    "wcwidth(",
    "codePointWidth(",
    "graphemeWidth(",
];

const ALLOW_PRAGMA: &str = "// allow-width-override:";

const SKIP_DIR_NAMES: &[&str] = &["node_modules", "dist", "build", "generated", "__generated__"];

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
                println!("check-paint-no-width-override --root <repo-root>");
                std::process::exit(0);
            }
            other => {
                eprintln!("check-paint-no-width-override: unknown argument: {other}");
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
            eprintln!("check-paint-no-width-override: {n} violation(s) of invariant I-4.");
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("check-paint-no-width-override: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path) -> Result<usize> {
    let mut violations = 0usize;
    let mut scanned = 0usize;
    for scan_rel in SCAN_ROOTS {
        let scan_root = root.join(scan_rel);
        if !scan_root.exists() {
            // Not yet scaffolded: skip gracefully so early-epic
            // branches are not blocked by missing UI trees.
            continue;
        }
        for entry in WalkDir::new(&scan_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_skipped(e))
        {
            let entry = entry.with_context(|| "walk UI subtree")?;
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
            for hit in scan_text(&text) {
                if has_allow_pragma_above(&text, hit.line) {
                    continue;
                }
                violations += 1;
                eprintln!(
                    "check-paint-no-width-override: {}:{}: {} (I-4)",
                    rel.display(),
                    hit.line,
                    hit.pattern
                );
            }
        }
    }
    println!(
        "check-paint-no-width-override: scanned {scanned} file(s); {violations} violation(s)",
    );
    Ok(violations)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub line: usize,
    pub pattern: String,
}

/// Scan a file. Pure — unit-tests feed synthetic strings and check
/// the resulting hits.
pub fn scan_text(text: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    let imports_permitted = text.contains(PERMITTED_WIDTH_SOURCE);

    for (i, line) in text.lines().enumerate() {
        let line_no = i + 1;
        let trimmed = line.trim_start();
        // Comments never trip the rule; prose may describe the
        // behaviour being forbidden.
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        for frag in FORBIDDEN_IMPORT_FRAGMENTS {
            if line.contains(frag) {
                hits.push(Hit {
                    line: line_no,
                    pattern: format!("import {frag}"),
                });
            }
        }
        if !imports_permitted {
            for call in FORBIDDEN_CALLS {
                if line.contains(call) {
                    hits.push(Hit {
                        line: line_no,
                        pattern: format!("ad-hoc call `{call}…)`"),
                    });
                }
            }
        }
    }
    hits
}

/// `// allow-width-override:` on the line immediately before
/// `line_no` (1-based) suppresses the hit.
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
    fn clean_renderer_file_passes() {
        let src = r#"
            import { drawCell } from './cell';
            export const render = () => drawCell();
        "#;
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn direct_unicode_width_import_fails() {
        let src = "import wcwidth from 'unicode-width';\n";
        let hits = scan_text(src);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].pattern.contains("unicode-width"));
    }

    #[test]
    fn string_width_import_fails() {
        let src = "import stringWidth from \"string-width\";\n";
        let hits = scan_text(src);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].pattern.contains("string-width"));
    }

    #[test]
    fn bare_charwidth_call_fails_without_shared_lib_width_import() {
        let src = "const w = charWidth(cp);\n";
        let hits = scan_text(src);
        assert!(
            hits.iter().any(|h| h.pattern.contains("charWidth")),
            "expected bare charWidth call to be flagged"
        );
    }

    #[test]
    fn charwidth_call_with_shared_lib_width_import_is_accepted() {
        let src = "import { charWidth } from '../../shared/lib/width';\nconst w = charWidth(cp);\n";
        assert!(scan_text(src).is_empty());
    }

    #[test]
    fn pragma_allows_single_call() {
        let src = "import { one } from 'x';\n// allow-width-override: legacy\nconst w = charWidth(cp);\n";
        let hits = scan_text(src);
        let unsuppressed: Vec<_> = hits
            .iter()
            .filter(|h| !has_allow_pragma_above(src, h.line))
            .collect();
        assert!(
            unsuppressed.is_empty(),
            "pragma must suppress the charWidth hit, got {hits:?}"
        );
    }

    #[test]
    fn comment_mentioning_unicode_width_is_accepted() {
        let src = "// NOTE: never import from 'unicode-width' here.\n";
        assert!(scan_text(src).is_empty());
    }
}
