//! `check-hex-imports` — CI enforcement for the hexagonal layout defined in ADR 0014.
//!
//! Scans every workspace member under `crates/*/src/` and verifies:
//!
//! 1. `domain/` source files never reference `adapters` (same crate or cross-crate).
//! 2. `domain/` source files never pull in infra runtimes (`tokio`, `async_trait`, `nix`,
//!    `portable-pty`, `rusqlite`, `reqwest`, etc.).
//! 3. `ports/` source files never reference `adapters`.
//! 4. No crate imports another crate's `adapters::...` module (cross-crate rule).
//!
//! The tool is intentionally minimal: `syn` for `use` parsing, `walkdir` for file
//! discovery, `toml` for Cargo manifest lookup, and `anyhow` for error plumbing.
//!
//! Missing crates are skipped with an informational line, never a panic — the repo
//! may legitimately be mid-scaffold while CI is wired up.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use syn::{visit::Visit, UseTree};
use walkdir::WalkDir;

/// Infra / runtime crates forbidden inside a domain layer. Keep this list
/// narrow and obvious; ADR 0014 is the source of truth. When in doubt, the
/// rule is: if it touches the OS, it does not belong in `domain/`.
const DOMAIN_DENYLIST: &[&str] = &[
    "tokio",
    "async_trait",
    "nix",
    "portable_pty", // crate name normalization: `-` → `_`
    "rusqlite",
    "reqwest",
    "hyper",
    "mio",
    "libc",
    "rayon",
    "zstd",
    "notify",
];

/// Which hexagonal layer a file belongs to, inferred from path segments.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layer {
    Domain,
    Ports,
    Adapters,
    /// Anything else in `src/` (lib.rs, main.rs, free-floating modules).
    /// We apply no rule to these — they are the crate's own composition.
    Other,
}

#[derive(Debug)]
struct Violation {
    file: PathBuf,
    line: usize,
    import: String,
    rule: &'static str,
}

struct Cli {
    root: PathBuf,
}

fn parse_cli() -> Cli {
    // Tiny hand-rolled arg parser — we don't want a clap dependency in a
    // CI-only tool. Supports `--root <path>` and defaults to CWD.
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
                println!("check-hex-imports --root <repo-root>");
                std::process::exit(0);
            }
            other => {
                eprintln!("check-hex-imports: unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    Cli { root }
}

fn main() -> ExitCode {
    let cli = parse_cli();
    match run(&cli.root) {
        Ok(violations) if violations.is_empty() => {
            println!("check-hex-imports: ok");
            ExitCode::SUCCESS
        }
        Ok(violations) => {
            eprintln!(
                "check-hex-imports: {} violation(s) of ADR 0014 found:\n",
                violations.len()
            );
            for v in &violations {
                eprintln!(
                    "  {}:{}\n    rule:   {}\n    import: {}\n",
                    v.file.display(),
                    v.line,
                    v.rule,
                    v.import.trim()
                );
            }
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("check-hex-imports: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path) -> Result<Vec<Violation>> {
    let crates_dir = root.join("crates");
    if !crates_dir.exists() {
        println!(
            "check-hex-imports: info: {} does not exist yet; nothing to check",
            crates_dir.display()
        );
        return Ok(Vec::new());
    }

    let crate_names = discover_crate_names(&crates_dir)?;
    if crate_names.is_empty() {
        println!("check-hex-imports: info: no crates discovered under crates/; nothing to check");
        return Ok(Vec::new());
    }

    let mut violations = Vec::new();
    let mut scanned_files = 0usize;

    for entry in
        fs::read_dir(&crates_dir).with_context(|| format!("read_dir {}", crates_dir.display()))?
    {
        let entry = entry?;
        let crate_root = entry.path();
        if !crate_root.is_dir() {
            continue;
        }
        let src_dir = crate_root.join("src");
        if !src_dir.exists() {
            println!(
                "check-hex-imports: info: {} has no src/; skipping",
                crate_root.display()
            );
            continue;
        }

        let this_crate = crate_root
            .file_name()
            .and_then(|s| s.to_str())
            .map(crate_name_to_ident)
            .unwrap_or_default();

        for file in walk_rust_files(&src_dir) {
            scanned_files += 1;
            let layer = infer_layer(&src_dir, &file);
            let source = match fs::read_to_string(&file) {
                Ok(s) => s,
                Err(err) => {
                    eprintln!(
                        "check-hex-imports: warn: could not read {}: {err}",
                        file.display()
                    );
                    continue;
                }
            };
            let imports = extract_use_paths(&source, &file);
            for imp in imports {
                if let Some(v) = classify(&imp, layer, &this_crate, &crate_names, &file) {
                    violations.push(v);
                }
            }
        }
    }

    println!(
        "check-hex-imports: scanned {scanned_files} file(s) across {} crate(s)",
        crate_names.len()
    );
    Ok(violations)
}

/// Discover every crate name by reading Cargo.toml `[package] name = "..."`.
/// Falls back to directory name if the manifest is missing or malformed.
fn discover_crate_names(crates_dir: &Path) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for entry in fs::read_dir(crates_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("Cargo.toml");
        let dir_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if manifest.exists() {
            match fs::read_to_string(&manifest)
                .and_then(|s| toml::from_str::<toml::Value>(&s).map_err(std::io::Error::other))
            {
                Ok(val) => {
                    let name = val
                        .get("package")
                        .and_then(|p| p.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or(&dir_name)
                        .to_string();
                    out.insert(name);
                    continue;
                }
                Err(err) => {
                    eprintln!(
                        "check-hex-imports: warn: could not parse {}: {err}",
                        manifest.display()
                    );
                }
            }
        }
        if !dir_name.is_empty() {
            out.insert(dir_name);
        }
    }
    Ok(out)
}

fn walk_rust_files(src_dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(src_dir)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("rs"))
        .map(walkdir::DirEntry::into_path)
        .collect()
}

/// Infer which layer a file belongs to from its path relative to `<crate>/src/`.
///
/// A file is in layer X if any path segment equals `x`. The first matching
/// segment wins, so `src/domain/mod.rs` is `Domain` and
/// `src/adapters/nested/thing.rs` is `Adapters`.
fn infer_layer(src_dir: &Path, file: &Path) -> Layer {
    let Ok(rel) = file.strip_prefix(src_dir) else {
        return Layer::Other;
    };
    for component in rel.components() {
        if let Some(s) = component.as_os_str().to_str() {
            match s {
                "domain" => return Layer::Domain,
                "ports" => return Layer::Ports,
                "adapters" => return Layer::Adapters,
                _ => {}
            }
        }
    }
    Layer::Other
}

/// Extract `use ...;` paths from a Rust source. Returns a list of
/// `(path_string, line_number, raw_line)`.
///
/// We use `syn` to parse the file (full syntax, so attribute macros and
/// `cfg_attr` do not trip us up). If parsing fails we skip the file with a
/// warning rather than erroring — a syntax error is the compiler's problem
/// to report, not this tool's.
fn extract_use_paths(source: &str, file: &Path) -> Vec<ExtractedImport> {
    let syntax = match syn::parse_file(source) {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "check-hex-imports: warn: could not parse {}: {err}",
                file.display()
            );
            return Vec::new();
        }
    };

    // Line index: for each `use` item, `syn` gives us `span().start().line`
    // on nightly but on stable we have `start()` via the `proc-macro2` span.
    // We walk the AST and collect paths, then map back to lines via the raw
    // text (find the nth `use` statement's starting line). This is fiddly;
    // we take a simpler and reliable approach: regex the raw source for the
    // line of each path's leading segment, cross-referenced with the AST.

    let mut visitor = UseVisitor::default();
    visitor.visit_file(&syntax);

    // Fallback line lookup: scan source for each path's leading segment on
    // a `use ...` line. Good enough for diagnostics.
    let lines: Vec<&str> = source.lines().collect();
    visitor
        .paths
        .into_iter()
        .map(|path| {
            let head = path.split("::").next().unwrap_or(&path);
            let (line_no, raw) = lines
                .iter()
                .enumerate()
                .find(|(_, l)| {
                    let t = l.trim_start();
                    (t.starts_with("use ") || t.starts_with("pub use "))
                        && l.contains(head)
                        && l.contains(&path.replace("::*", ""))
                })
                .or_else(|| {
                    lines.iter().enumerate().find(|(_, l)| {
                        let t = l.trim_start();
                        (t.starts_with("use ") || t.starts_with("pub use ")) && l.contains(head)
                    })
                })
                .map_or((0, String::new()), |(i, l)| (i + 1, (*l).to_string()));
            ExtractedImport {
                path,
                line: line_no,
                raw,
            }
        })
        .collect()
}

struct ExtractedImport {
    /// Fully qualified leading path of the `use`, e.g. `tokio::sync::Mutex`
    /// or `crate::adapters::foo`. Glob, rename, and group are flattened.
    path: String,
    line: usize,
    raw: String,
}

#[derive(Default)]
struct UseVisitor {
    paths: Vec<String>,
}

impl<'ast> Visit<'ast> for UseVisitor {
    fn visit_item_use(&mut self, i: &'ast syn::ItemUse) {
        collect_use_tree(&i.tree, &mut String::new(), &mut self.paths);
    }
}

fn collect_use_tree(tree: &UseTree, prefix: &mut String, out: &mut Vec<String>) {
    match tree {
        UseTree::Path(p) => {
            let ident = p.ident.to_string();
            let save = prefix.len();
            if !prefix.is_empty() {
                prefix.push_str("::");
            }
            prefix.push_str(&ident);
            collect_use_tree(&p.tree, prefix, out);
            prefix.truncate(save);
        }
        UseTree::Name(n) => {
            let ident = n.ident.to_string();
            out.push(joined(prefix, &ident));
        }
        UseTree::Rename(r) => {
            let ident = r.ident.to_string();
            out.push(joined(prefix, &ident));
        }
        UseTree::Glob(_) => {
            out.push(joined(prefix, "*"));
        }
        UseTree::Group(g) => {
            for t in &g.items {
                collect_use_tree(t, prefix, out);
            }
        }
    }
}

fn joined(prefix: &str, tail: &str) -> String {
    if prefix.is_empty() {
        tail.to_string()
    } else {
        format!("{prefix}::{tail}")
    }
}

/// Given an import, the file's layer, and the set of sibling crate names,
/// return a `Violation` if a rule is broken.
fn classify(
    import: &ExtractedImport,
    layer: Layer,
    this_crate_ident: &str,
    sibling_crates: &BTreeSet<String>,
    file: &Path,
) -> Option<Violation> {
    let head = import.path.split("::").next().unwrap_or("").to_string();
    let normalized_head = head.replace('-', "_");

    // Rule: no crate may reach into another crate's adapters.
    //
    // `use <crate_name>::adapters::...` is banned everywhere (even for the
    // owning crate's siblings). The owning crate's own `lib.rs`/`main.rs` is
    // allowed to `pub mod adapters;` and internal adapter code may refer to
    // adapters; those are NOT `use` imports that cross the boundary. We only
    // inspect `use` paths, so this filter is safe.
    if sibling_crates.iter().any(|c| {
        let c_ident = crate_name_to_ident(c);
        c_ident == normalized_head && c_ident != this_crate_ident
    }) && import.path.contains("::adapters")
    {
        return Some(Violation {
            file: file.to_path_buf(),
            line: import.line,
            import: import.raw.clone(),
            rule: "cross-crate import of another crate's `adapters` is forbidden (ADR 0014)",
        });
    }

    match layer {
        Layer::Domain => {
            // No reach into any `adapters` — same crate (via `crate::`) or cross-crate.
            if import.path.starts_with("crate::adapters")
                || import.path.starts_with("super::adapters")
                || import.path.contains("::adapters::")
                || import.path == "crate::adapters"
            {
                return Some(Violation {
                    file: file.to_path_buf(),
                    line: import.line,
                    import: import.raw.clone(),
                    rule: "domain/ must not import from adapters/ (ADR 0014)",
                });
            }
            // No infra runtime crates.
            if DOMAIN_DENYLIST.contains(&normalized_head.as_str()) {
                return Some(Violation {
                    file: file.to_path_buf(),
                    line: import.line,
                    import: import.raw.clone(),
                    rule: "domain/ must not depend on IO/runtime crates (ADR 0014)",
                });
            }
        }
        Layer::Ports => {
            if import.path.starts_with("crate::adapters")
                || import.path.starts_with("super::adapters")
                || import.path.contains("::adapters::")
                || import.path == "crate::adapters"
            {
                return Some(Violation {
                    file: file.to_path_buf(),
                    line: import.line,
                    import: import.raw.clone(),
                    rule: "ports/ must not import from adapters/ (ADR 0014)",
                });
            }
        }
        Layer::Adapters | Layer::Other => {
            // Adapters are allowed to touch infra; `Other` (lib.rs, binaries)
            // are composition-root-adjacent and only constrained by the
            // cross-crate rule above.
        }
    }

    None
}

/// Normalize a crate name (`quanta-pty`) to its Rust identifier form
/// (`quanta_pty`) so `use quanta_pty::...` matches.
fn crate_name_to_ident(name: &str) -> String {
    name.replace('-', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_extract(source: &str) -> Vec<String> {
        let path = PathBuf::from("dummy.rs");
        extract_use_paths(source, &path)
            .into_iter()
            .map(|i| i.path)
            .collect()
    }

    #[test]
    fn extracts_simple_use() {
        let paths = tmp_extract("use tokio::sync::Mutex;\n");
        assert_eq!(paths, vec!["tokio::sync::Mutex"]);
    }

    #[test]
    fn extracts_grouped_use() {
        let paths = tmp_extract("use std::{io, fs::File};\n");
        assert!(paths.contains(&"std::io".to_string()));
        assert!(paths.contains(&"std::fs::File".to_string()));
    }

    #[test]
    fn domain_rejects_adapters_import() {
        let import = ExtractedImport {
            path: "crate::adapters::foo".to_string(),
            line: 1,
            raw: "use crate::adapters::foo;".to_string(),
        };
        let siblings = BTreeSet::new();
        let v = classify(
            &import,
            Layer::Domain,
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_some());
    }

    #[test]
    fn domain_rejects_tokio() {
        let import = ExtractedImport {
            path: "tokio::sync::Mutex".to_string(),
            line: 1,
            raw: "use tokio::sync::Mutex;".to_string(),
        };
        let siblings = BTreeSet::new();
        let v = classify(
            &import,
            Layer::Domain,
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_some());
    }

    #[test]
    fn ports_rejects_adapters() {
        let import = ExtractedImport {
            path: "super::adapters::bar".to_string(),
            line: 1,
            raw: "use super::adapters::bar;".to_string(),
        };
        let siblings = BTreeSet::new();
        let v = classify(
            &import,
            Layer::Ports,
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_some());
    }

    #[test]
    fn ports_allows_tokio() {
        // Ports may use async_trait / tokio types in signatures — the
        // denylist only applies to domain/.
        let import = ExtractedImport {
            path: "tokio::io::AsyncRead".to_string(),
            line: 1,
            raw: "use tokio::io::AsyncRead;".to_string(),
        };
        let siblings = BTreeSet::new();
        let v = classify(
            &import,
            Layer::Ports,
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_none());
    }

    #[test]
    fn cross_crate_adapters_forbidden() {
        let import = ExtractedImport {
            path: "quanta_session::adapters::sqlite".to_string(),
            line: 1,
            raw: "use quanta_session::adapters::sqlite;".to_string(),
        };
        let mut siblings = BTreeSet::new();
        siblings.insert("quanta-session".to_string());
        siblings.insert("quanta-pty".to_string());
        let v = classify(
            &import,
            Layer::Adapters, // even adapter code cannot cross into a sibling's adapters
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_some());
    }

    #[test]
    fn cross_crate_domain_ok() {
        let import = ExtractedImport {
            path: "quanta_proto::events::Event".to_string(),
            line: 1,
            raw: "use quanta_proto::events::Event;".to_string(),
        };
        let mut siblings = BTreeSet::new();
        siblings.insert("quanta-proto".to_string());
        let v = classify(
            &import,
            Layer::Domain,
            "quanta_pty",
            &siblings,
            Path::new("x.rs"),
        );
        assert!(v.is_none());
    }
}
