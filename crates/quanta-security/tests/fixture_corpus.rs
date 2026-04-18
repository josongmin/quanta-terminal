//! Corpus test — walks `fixtures/{env,commands,tokens}` and asserts the
//! default detector's output matches the expectation files.
//!
//! The fixtures are JSON-per-case so adding a scenario is a one-file edit.
//! False positives and false negatives are BOTH fatal — see ADR 0006
//! §False-Positive Control.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use quanta_security::{DefaultDetector, SecretClass, SecretDetector};
use serde::Deserialize;

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> T {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse fixture {}: {e}", path.display()))
}

fn list_jsons(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    out.sort();
    out
}

// ── env fixtures ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct EnvCase {
    #[allow(dead_code)]
    description: String,
    key: String,
    value: String,
    expected: Vec<ExpectedEntry>,
}

#[derive(Deserialize)]
struct ExpectedEntry {
    class: String,
    #[allow(dead_code)]
    rule_id: String,
}

#[test]
fn env_fixtures_corpus() {
    let dir = fixtures_root().join("env");
    let cases = list_jsons(&dir);
    assert!(cases.len() >= 5, "at least 5 env fixtures required");
    let d = DefaultDetector::new();
    for path in cases {
        let case: EnvCase = read_json(&path);
        let got = d.scan_env_entry(&case.key, &case.value);
        if case.expected.is_empty() {
            assert!(
                got.is_none(),
                "{}: benign env entry unexpectedly redacted: {:?}",
                path.display(),
                got
            );
        } else {
            let r =
                got.unwrap_or_else(|| panic!("{}: expected redaction, got None", path.display()));
            assert_eq!(
                r.class.label(),
                case.expected[0].class,
                "{}: class mismatch",
                path.display()
            );
            assert_eq!(
                r.ruleset_version,
                quanta_security::RULESET_VERSION,
                "{}: ruleset_version mismatch",
                path.display()
            );
        }
    }
}

// ── command fixtures ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CommandCase {
    #[allow(dead_code)]
    description: String,
    command: String,
    expected_classes: Vec<String>,
    forbidden_substring: Option<String>,
}

#[test]
fn command_fixtures_corpus() {
    let dir = fixtures_root().join("commands");
    let cases = list_jsons(&dir);
    assert!(cases.len() >= 5, "at least 5 command fixtures required");
    let d = DefaultDetector::new();
    for path in cases {
        let case: CommandCase = read_json(&path);
        let got = d.scan_command(&case.command);
        let got_classes: BTreeSet<String> =
            got.iter().map(|r| r.class.label().to_string()).collect();
        let expected_classes: BTreeSet<String> = case.expected_classes.iter().cloned().collect();
        if expected_classes.is_empty() {
            assert!(
                got.is_empty(),
                "{}: benign command unexpectedly redacted: {:?}",
                path.display(),
                got
            );
        } else {
            for c in &expected_classes {
                assert!(
                    got_classes.contains(c),
                    "{}: expected class {c} not found in {:?}",
                    path.display(),
                    got_classes
                );
            }
        }
        if let Some(forbidden) = case.forbidden_substring {
            let display = quanta_security::domain::render_display(&case.command, &got);
            assert!(
                !display.contains(&forbidden),
                "{}: display still contains raw secret {forbidden:?}: {display}",
                path.display()
            );
        }
    }
}

// ── token fixtures ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenCase {
    #[allow(dead_code)]
    description: String,
    output: String,
    expected_rule_ids: Vec<String>,
}

#[test]
fn token_fixtures_corpus() {
    let dir = fixtures_root().join("tokens");
    let cases = list_jsons(&dir);
    assert!(cases.len() >= 8, "at least 8 token fixtures required");
    let d = DefaultDetector::new();
    for path in cases {
        let case: TokenCase = read_json(&path);
        let got = d.scan_output(case.output.as_bytes());
        for r in &got {
            assert_eq!(
                r.class,
                SecretClass::OutputWellKnownToken,
                "{}: scan_output must yield OutputWellKnownToken",
                path.display()
            );
        }
        let got_ids: BTreeSet<String> = got.iter().map(|r| r.rule_id.clone()).collect();
        for rid in case.expected_rule_ids {
            assert!(
                got_ids.contains(&rid),
                "{}: expected rule id {rid} not found in {:?}",
                path.display(),
                got_ids
            );
        }
    }
}
