//! Corpus-driven acceptance test for the VTE boundary detector.
//!
//! Walks `crates/quanta-block/fixtures/boundary/` — every subdirectory
//! containing `input.bin` + `expected.json` is a case. The case's bytes are
//! fed through `VteBoundaryDetector` and the emitted events are compared
//! against the expected event list.
//!
//! A fixture is a Round-3 stake in the ground: any later change to the
//! detector that alters its output for one of these inputs fails CI.

use std::path::{Path, PathBuf};

use quanta_block::{BoundaryEvent, VteBoundaryDetector};
use serde::{Deserialize, Serialize};

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

fn corpus_root() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is the crate root. Fixtures live under it.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/boundary")
}

fn list_cases(root: &Path) -> Vec<PathBuf> {
    let mut cases: Vec<PathBuf> = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return cases;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("input.bin").is_file() && path.join("expected.json").is_file()
        {
            cases.push(path);
        }
    }
    cases.sort();
    cases
}

#[test]
fn corpus_is_nonempty() {
    let cases = list_cases(&corpus_root());
    assert!(
        !cases.is_empty(),
        "boundary corpus is empty at {}",
        corpus_root().display()
    );
    // Guards against accidental deletion of the corpus: if a future commit
    // removes every fixture, this asserts a floor on coverage.
    assert!(
        cases.len() >= 8,
        "expected at least 8 boundary fixtures, found {}",
        cases.len()
    );
}

#[test]
fn every_case_matches_expected() {
    let mut failures: Vec<String> = Vec::new();
    for case in list_cases(&corpus_root()) {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        let input = std::fs::read(case.join("input.bin")).expect("read input.bin");
        let expected_bytes = std::fs::read(case.join("expected.json")).expect("read expected.json");
        let expected: Vec<ExpectedBoundaryEvent> =
            serde_json::from_slice(&expected_bytes).expect("parse expected.json");

        let mut detector = VteBoundaryDetector::new();
        let mut sink: Vec<BoundaryEvent> = Vec::new();
        detector.feed(&input, &mut sink);
        let actual: Vec<ExpectedBoundaryEvent> = sink
            .iter()
            .map(ExpectedBoundaryEvent::from_detected)
            .collect();

        if actual != expected {
            failures.push(format!(
                "case `{name}`: expected={expected:?} actual={actual:?}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "boundary corpus divergence:\n  {}",
        failures.join("\n  ")
    );
}

/// Feeding the same bytes in chunked halves must produce the same events as a
/// single-shot feed — the detector's chunk independence is load-bearing for
/// the PTY read loop.
#[test]
fn chunked_feed_matches_single_shot() {
    for case in list_cases(&corpus_root()) {
        let input = std::fs::read(case.join("input.bin")).expect("read input.bin");
        if input.len() < 2 {
            continue;
        }
        let (a, b) = input.split_at(input.len() / 2);

        let mut d1 = VteBoundaryDetector::new();
        let mut s1: Vec<BoundaryEvent> = Vec::new();
        d1.feed(&input, &mut s1);

        let mut d2 = VteBoundaryDetector::new();
        let mut s2: Vec<BoundaryEvent> = Vec::new();
        d2.feed(a, &mut s2);
        d2.feed(b, &mut s2);

        assert_eq!(
            s1,
            s2,
            "chunk-independence failed for case {}",
            case.display()
        );
    }
}
