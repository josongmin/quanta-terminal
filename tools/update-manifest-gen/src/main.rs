//! `update-manifest-gen` — assemble the signed Tauri update manifest.
//!
//! Consumes a directory tree of built bundles (the `artifacts/` layout
//! produced by `.github/workflows/release.yml` after every platform
//! matrix job has uploaded its `bundle-*` artifact) and emits a single
//! JSON manifest matching Tauri's updater plugin schema:
//!
//! ```json
//! {
//!   "version": "0.2.0",
//!   "pub_date": "2026-04-19T09:00:00Z",
//!   "platforms": {
//!     "darwin-aarch64": {
//!       "signature": "…",
//!       "url": "https://updates.quanta-terminal.dev/…"
//!     }
//!   }
//! }
//! ```
//!
//! # Signing
//!
//! Tauri signs bundles with `minisign` (via the `tauri-signer` CLI or the
//! `minisign` crate). In CI the signature files are produced *alongside*
//! the bundle by the Tauri build step — this tool just consumes the
//! `.sig` sidecar. If no signature is found for a bundle, the manifest
//! entry records an empty string so the updater will skip it; a warning
//! is logged to stderr.
//!
//! # CLI
//!
//! ```text
//! update-manifest-gen \
//!   --version 0.2.0 \
//!   --bundles-dir artifacts \
//!   --output-path out/latest.json \
//!   [--release-url-base https://updates.quanta-terminal.dev]
//! ```
//!
//! If `--release-url-base` is omitted, the URL is a `file://` reference
//! to the bundle (useful for offline testing; the host should always
//! override in CI).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use serde::Serialize;
use walkdir::WalkDir;

/// Top-level manifest payload.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    pub pub_date: String,
    pub platforms: BTreeMap<String, PlatformEntry>,
}

/// One platform's signature + download URL.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PlatformEntry {
    pub signature: String,
    pub url: String,
}

#[derive(Debug)]
struct Cli {
    version: String,
    bundles_dir: PathBuf,
    output_path: PathBuf,
    release_url_base: Option<String>,
}

fn parse_cli() -> Result<Cli> {
    let mut version = None;
    let mut bundles_dir = None;
    let mut output_path = None;
    let mut release_url_base = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" => version = args.next(),
            "--bundles-dir" => bundles_dir = args.next().map(PathBuf::from),
            "--output-path" => output_path = args.next().map(PathBuf::from),
            "--release-url-base" => release_url_base = args.next(),
            "-h" | "--help" => {
                eprintln!(
                    "update-manifest-gen --version <ver> --bundles-dir <dir> --output-path <path> [--release-url-base <url>]"
                );
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }
    Ok(Cli {
        version: version.context("--version is required")?,
        bundles_dir: bundles_dir.context("--bundles-dir is required")?,
        output_path: output_path.context("--output-path is required")?,
        release_url_base,
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("update-manifest-gen: {err:#}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<()> {
    let cli = parse_cli()?;
    let entries = discover_bundles(&cli.bundles_dir)?;
    let platforms = build_platforms(&entries, cli.release_url_base.as_deref())?;
    if platforms.is_empty() {
        eprintln!(
            "update-manifest-gen: warn: no bundles found under {}; manifest will be empty",
            cli.bundles_dir.display()
        );
    }
    let manifest = Manifest {
        version: cli.version,
        pub_date: now_rfc3339(),
        platforms,
    };
    if let Some(parent) = cli.output_path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir -p {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&cli.output_path, json)
        .with_context(|| format!("write {}", cli.output_path.display()))?;
    eprintln!(
        "update-manifest-gen: wrote {} ({} platform(s))",
        cli.output_path.display(),
        manifest.platforms.len()
    );
    Ok(())
}

/// A single discovered bundle + its signature sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredBundle {
    /// Absolute path to the bundle asset (.dmg/.msi/.AppImage/…).
    pub bundle: PathBuf,
    /// The Tauri platform key (`darwin-aarch64`, `windows-x86_64`, …).
    pub platform_key: String,
    /// Content of the matching `.sig`/`.asc` file, or `None` if missing.
    pub signature: Option<String>,
}

/// Walk the bundles directory, classify each asset, and pair it with its
/// signature. The classifier recognises:
///
/// - `*.dmg` / `*.app.tar.gz` → macOS. Arch is inferred from the filename;
///   the release workflow names bundles per the matrix label.
/// - `*.msi` / `*.exe` → `windows-x86_64` (only 64-bit today).
/// - `*.AppImage` / `*.deb` → `linux-x86_64`.
pub fn discover_bundles(dir: &Path) -> Result<Vec<DiscoveredBundle>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip signature sidecars — they're paired in the bundle pass. Use
        // case-insensitive extension lookup because the workflow preserves
        // the filename the bundler emitted verbatim; some tools uppercase.
        let lower = filename.to_ascii_lowercase();
        if ext_eq(&lower, "sig") || ext_eq(&lower, "asc") {
            continue;
        }
        let Some(platform_key) = classify_platform(filename, &path) else {
            continue;
        };
        let signature = find_signature(&path)?;
        out.push(DiscoveredBundle {
            bundle: path,
            platform_key,
            signature,
        });
    }
    out.sort_by(|a, b| a.platform_key.cmp(&b.platform_key));
    Ok(out)
}

fn classify_platform(filename: &str, path: &Path) -> Option<String> {
    let lc = filename.to_ascii_lowercase();
    let full = path.to_string_lossy().to_ascii_lowercase();
    // Arch hints from the filename or the parent folder (the release
    // workflow stages per-matrix under `bundle-macos-arm64/` etc.).
    let is_arm64 = full.contains("arm64") || full.contains("aarch64");
    let is_x86_64 = full.contains("x86_64") || full.contains("x64") || full.contains("amd64");
    // Extension checks go through a helper that normalises to lowercase
    // so macOS installers named `Quanta.DMG` still classify correctly.
    // `app.tar.gz` is the Tauri updater bundle layout (not a plain
    // extension), so it's matched via `ends_with` on the lowercased name.
    if ext_eq(&lc, "dmg") || lc.ends_with(".app.tar.gz") {
        if is_arm64 {
            return Some("darwin-aarch64".into());
        }
        if is_x86_64 {
            return Some("darwin-x86_64".into());
        }
        // Default: most modern macOS builds are arm64. Log ambiguity.
        eprintln!(
            "update-manifest-gen: warn: macOS bundle {filename} missing arch hint; defaulting to darwin-aarch64"
        );
        return Some("darwin-aarch64".into());
    }
    if ext_eq(&lc, "msi") || ext_eq(&lc, "exe") {
        return Some("windows-x86_64".into());
    }
    if ext_eq(&lc, "appimage") || ext_eq(&lc, "deb") {
        return Some("linux-x86_64".into());
    }
    None
}

/// Case-insensitive single-extension match. Works on an already-lowercased
/// haystack; takes a lowercase `needle` (no leading dot).
fn ext_eq(lowercased_filename: &str, needle_without_dot: &str) -> bool {
    std::path::Path::new(lowercased_filename)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(needle_without_dot))
}

/// Look for a `.sig` sibling (Tauri updater minisign format) first, then
/// fall back to `.asc` (the Linux GPG detached signature). Returns the
/// file's textual content so the manifest can carry the full signature
/// rather than a path.
fn find_signature(bundle: &Path) -> Result<Option<String>> {
    for ext in ["sig", "asc"] {
        let candidate = PathBuf::from(format!("{}.{ext}", bundle.display()));
        if candidate.is_file() {
            let content = fs::read_to_string(&candidate)
                .with_context(|| format!("read {}", candidate.display()))?;
            return Ok(Some(content.trim().to_string()));
        }
    }
    Ok(None)
}

/// Fold discovered bundles into Tauri's `platforms` map.
pub fn build_platforms(
    entries: &[DiscoveredBundle],
    release_url_base: Option<&str>,
) -> Result<BTreeMap<String, PlatformEntry>> {
    let mut out = BTreeMap::new();
    for e in entries {
        let signature = e.signature.clone().unwrap_or_else(|| {
            eprintln!(
                "update-manifest-gen: warn: no signature for {} ({}); updater will refuse this entry",
                e.bundle.display(),
                e.platform_key
            );
            String::new()
        });
        let url = match release_url_base {
            Some(base) => {
                let name = e
                    .bundle
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                format!("{}/{}", base.trim_end_matches('/'), name)
            }
            None => format!("file://{}", e.bundle.display()),
        };
        // If two bundles map to the same platform key, the last one wins
        // deterministically (entries are sorted by key). Warn so operators
        // know a dedupe happened.
        if out.contains_key(&e.platform_key) {
            eprintln!(
                "update-manifest-gen: warn: duplicate bundle for platform {}; overwriting",
                e.platform_key
            );
        }
        out.insert(e.platform_key.clone(), PlatformEntry { signature, url });
    }
    Ok(out)
}

fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_platform_keys() {
        assert_eq!(
            classify_platform(
                "Quanta_0.2.0_aarch64.dmg",
                Path::new("x/Quanta_0.2.0_aarch64.dmg")
            ),
            Some("darwin-aarch64".into())
        );
        assert_eq!(
            classify_platform("Quanta_0.2.0_x64.msi", Path::new("x/Quanta_0.2.0_x64.msi")),
            Some("windows-x86_64".into())
        );
        assert_eq!(
            classify_platform(
                "Quanta-0.2.0.AppImage",
                Path::new("x/Quanta-0.2.0.AppImage")
            ),
            Some("linux-x86_64".into())
        );
        assert_eq!(
            classify_platform("README.md", Path::new("x/README.md")),
            None
        );
    }

    #[test]
    fn discover_pairs_signature_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        // Stage: artifacts/bundle-macos-arm64/Quanta_0.2.0_aarch64.dmg
        //        artifacts/bundle-macos-arm64/Quanta_0.2.0_aarch64.dmg.sig
        let dir = tmp.path().join("bundle-macos-arm64");
        fs::create_dir_all(&dir).unwrap();
        let bundle_path = dir.join("Quanta_0.2.0_aarch64.dmg");
        fs::write(&bundle_path, b"FAKEDMG").unwrap();
        fs::write(format!("{}.sig", bundle_path.display()), "FAKESIG\n").unwrap();
        let entries = discover_bundles(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].platform_key, "darwin-aarch64");
        assert_eq!(entries[0].signature.as_deref(), Some("FAKESIG"));
    }

    #[test]
    fn build_platforms_uses_release_url_base() {
        let entry = DiscoveredBundle {
            bundle: PathBuf::from("/tmp/Quanta_0.2.0_aarch64.dmg"),
            platform_key: "darwin-aarch64".into(),
            signature: Some("SIG".into()),
        };
        let map = build_platforms(&[entry], Some("https://updates.example.com/")).unwrap();
        let p = map.get("darwin-aarch64").unwrap();
        assert_eq!(p.signature, "SIG");
        assert_eq!(
            p.url,
            "https://updates.example.com/Quanta_0.2.0_aarch64.dmg"
        );
    }

    #[test]
    fn build_platforms_records_empty_signature_when_missing() {
        let entry = DiscoveredBundle {
            bundle: PathBuf::from("/tmp/Quanta_0.2.0_aarch64.dmg"),
            platform_key: "darwin-aarch64".into(),
            signature: None,
        };
        let map = build_platforms(&[entry], Some("https://u.example.com")).unwrap();
        assert_eq!(map.get("darwin-aarch64").unwrap().signature, "");
    }

    #[test]
    fn manifest_serializes_with_expected_top_level_fields() {
        let mut platforms = BTreeMap::new();
        platforms.insert(
            "darwin-aarch64".to_string(),
            PlatformEntry {
                signature: "s".into(),
                url: "https://u.example.com/x.dmg".into(),
            },
        );
        let m = Manifest {
            version: "0.2.0".into(),
            pub_date: "2026-04-19T00:00:00Z".into(),
            platforms,
        };
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["version"], "0.2.0");
        assert_eq!(v["pub_date"], "2026-04-19T00:00:00Z");
        assert!(v["platforms"]["darwin-aarch64"].is_object());
    }
}
