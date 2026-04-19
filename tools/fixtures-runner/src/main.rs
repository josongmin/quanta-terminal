//! `fixtures-runner` — corpus walker for boundary and diagnostic fixtures
//! (ADR 0007, ADR 0014).
//!
//! Modes:
//! - Default / `--corpus <path>` over a boundary corpus (`input.bin` +
//!   `expected.json` per case). Runs each case through the VTE boundary
//!   detector and diffs against the expected events. Exits 0 on all-pass,
//!   non-zero on any fail.
//! - If the corpus contains subdirs with `input.txt` (diagnostic shape), they
//!   are enumerated but skipped with a NOTE line because the diagnostic
//!   adapter is not yet wired.
//!
//! Deliberately small: this is a developer tool, not a unit test.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{anyhow, Context, Result};
use quanta_block::{BoundaryEvent, VteBoundaryDetector};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

struct Cli {
    corpus_root: PathBuf,
    verbose: bool,
}

fn parse_cli() -> Result<Cli> {
    let mut args = std::env::args().skip(1);
    // Default root: boundary corpus. Overridable via `--corpus`/`--fixtures`.
    let mut corpus_root = PathBuf::from("crates/quanta-block/fixtures/boundary");
    let mut verbose = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--corpus" | "--fixtures" | "--root" => {
                corpus_root = PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow!("--corpus requires a path argument"))?,
                );
            }
            "-v" | "--verbose" => verbose = true,
            "-h" | "--help" => {
                println!(
                    "fixtures-runner [--corpus <path>] [--verbose]\n\
                     \n\
                     Walks a fixture corpus. For boundary corpora (input.bin + expected.json)\n\
                     each case is driven through the VTE boundary detector and diffed\n\
                     against its expected event list. Exits 0 on all-pass, non-zero\n\
                     if any case diverges or if the corpus is unreadable."
                );
                std::process::exit(0);
            }
            other => {
                return Err(anyhow!("unknown argument: {other}"));
            }
        }
    }
    Ok(Cli {
        corpus_root,
        verbose,
    })
}

fn main() -> ExitCode {
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fixtures-runner: {e:#}");
            return ExitCode::from(2);
        }
    };
    match run(&cli) {
        Ok(summary) => {
            println!(
                "fixtures-runner: {}/{} passed, {} failed, {} skipped under {}",
                summary.passed,
                summary.cases,
                summary.failed,
                summary.skipped,
                cli.corpus_root.display()
            );
            if summary.failed > 0 {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(err) => {
            eprintln!("fixtures-runner: fatal: {err:#}");
            ExitCode::from(2)
        }
    }
}

#[derive(Default, Debug)]
struct Summary {
    cases: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
}

fn run(cli: &Cli) -> Result<Summary> {
    let mut s = Summary::default();
    if !cli.corpus_root.exists() {
        println!(
            "fixtures-runner: note: {} does not exist",
            cli.corpus_root.display()
        );
        return Ok(s);
    }

    for case in enumerate_cases(&cli.corpus_root)? {
        s.cases += 1;
        let name = case
            .strip_prefix(&cli.corpus_root)
            .unwrap_or(&case)
            .display()
            .to_string();

        let input_bin = case.join("input.bin");
        let input_txt = case.join("input.txt");
        let expected = case.join("expected.json");

        if input_bin.is_file() && expected.is_file() {
            match run_boundary_case(&input_bin, &expected) {
                Ok(Outcome::Pass) => {
                    s.passed += 1;
                    println!("PASS boundary   {name}");
                }
                Ok(Outcome::Fail { diff }) => {
                    s.failed += 1;
                    println!("FAIL boundary   {name}");
                    for line in diff.lines() {
                        println!("    {line}");
                    }
                }
                Err(err) => {
                    s.failed += 1;
                    println!("FAIL boundary   {name}: {err:#}");
                }
            }
        } else if input_txt.is_file() && expected.is_file() {
            s.skipped += 1;
            println!("SKIP diagnostic {name} (adapter not implemented)");
        } else if cli.verbose {
            s.skipped += 1;
            println!("SKIP unknown    {name}");
        } else {
            s.skipped += 1;
        }
    }

    Ok(s)
}

fn enumerate_cases(root: &Path) -> Result<Vec<PathBuf>> {
    // A case is any directory that directly contains `expected.json` plus one
    // of the accepted input files.
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(std::result::Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name != "expected.json" {
            continue;
        }
        let dir = entry
            .path()
            .parent()
            .ok_or_else(|| anyhow!("expected.json has no parent"))?
            .to_path_buf();
        if seen.insert(dir.clone()) {
            out.push(dir);
        }
    }
    out.sort();
    Ok(out)
}

enum Outcome {
    Pass,
    Fail { diff: String },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ExpectedBoundaryEvent {
    PromptStart,
    CommandStart,
    OutputStart,
    CommandDone {
        #[serde(default)]
        exit_code: Option<i32>,
    },
    CwdAdvertised {
        cwd: String,
    },
    AltScreenEntered,
    AltScreenExited,
}

impl ExpectedBoundaryEvent {
    fn from_detected(ev: &BoundaryEvent) -> Self {
        match ev {
            BoundaryEvent::PromptStart => Self::PromptStart,
            BoundaryEvent::CommandStart => Self::CommandStart,
            BoundaryEvent::OutputStart => Self::OutputStart,
            BoundaryEvent::CommandDone { exit_code } => Self::CommandDone {
                exit_code: *exit_code,
            },
            BoundaryEvent::CwdAdvertised { cwd } => Self::CwdAdvertised { cwd: cwd.clone() },
            BoundaryEvent::AltScreenEntered => Self::AltScreenEntered,
            BoundaryEvent::AltScreenExited => Self::AltScreenExited,
        }
    }
}

fn run_boundary_case(input: &Path, expected: &Path) -> Result<Outcome> {
    let input_bytes = std::fs::read(input).with_context(|| format!("read {}", input.display()))?;
    let expected_bytes =
        std::fs::read(expected).with_context(|| format!("read {}", expected.display()))?;
    let expected_events: Vec<ExpectedBoundaryEvent> =
        serde_json::from_slice(&expected_bytes).context("parse expected.json")?;

    let mut detector = VteBoundaryDetector::new();
    let mut sink: Vec<BoundaryEvent> = Vec::new();
    detector.feed(&input_bytes, &mut sink);
    let actual: Vec<ExpectedBoundaryEvent> = sink
        .iter()
        .map(ExpectedBoundaryEvent::from_detected)
        .collect();

    if actual == expected_events {
        Ok(Outcome::Pass)
    } else {
        let diff = render_diff(&expected_events, &actual);
        Ok(Outcome::Fail { diff })
    }
}

fn render_diff<T: std::fmt::Debug>(expected: &[T], actual: &[T]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    out.push_str("expected:\n");
    for (i, e) in expected.iter().enumerate() {
        let _ = writeln!(out, "  {i}: {e:?}");
    }
    out.push_str("actual:\n");
    for (i, a) in actual.iter().enumerate() {
        let _ = writeln!(out, "  {i}: {a:?}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_root_is_ok() {
        let cli = Cli {
            corpus_root: PathBuf::from("/definitely/not/a/path/here"),
            verbose: false,
        };
        let s = run(&cli).expect("must not error on missing root");
        assert_eq!(s.cases, 0);
        assert_eq!(s.failed, 0);
    }

    #[test]
    fn boundary_case_passes_with_matching_expected() {
        let dir = tempdir();
        let case = dir.join("ok");
        std::fs::create_dir_all(&case).unwrap();
        std::fs::write(case.join("input.bin"), b"\x1b]133;A\x1b\\").unwrap();
        std::fs::write(case.join("expected.json"), br#"[{"kind":"prompt_start"}]"#).unwrap();
        let cli = Cli {
            corpus_root: dir.clone(),
            verbose: false,
        };
        let s = run(&cli).unwrap();
        assert_eq!(s.cases, 1);
        assert_eq!(s.passed, 1);
        assert_eq!(s.failed, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn boundary_case_fails_on_divergence() {
        let dir = tempdir();
        let case = dir.join("bad");
        std::fs::create_dir_all(&case).unwrap();
        std::fs::write(case.join("input.bin"), b"plain text").unwrap();
        std::fs::write(case.join("expected.json"), br#"[{"kind":"prompt_start"}]"#).unwrap();
        let cli = Cli {
            corpus_root: dir.clone(),
            verbose: false,
        };
        let s = run(&cli).unwrap();
        assert_eq!(s.cases, 1);
        assert_eq!(s.failed, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tempdir() -> PathBuf {
        // Tests run in parallel inside a single process, so both
        // `process::id()` and `SystemTime::now()` can collide at
        // nanosecond granularity. A monotonically-increasing atomic
        // counter is race-free and sufficient: each call burns one
        // unique suffix even under heavy parallelism. Using `Instant`
        // instead of `SystemTime` also hardens against NTP clock jumps
        // (B2 hygiene): the suffix uniqueness does not depend on wall
        // clock ordering.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "fixtures-runner-test-{}-{}",
            std::process::id(),
            seq
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
