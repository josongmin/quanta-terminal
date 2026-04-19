//! EPIC-G — Compat matrix golden-replay harness.
//!
//! One `#[test]` per compat fixture directory. Each test reads
//! `crates/quanta-vt/tests/compat/<program>/input.pty`, feeds it through a
//! fresh `Grid::new(24, 80, 10_000, classifier())`, and byte-for-byte
//! compares the resulting `GridSnapshot`, `CursorPayload`, and
//! `TerminalModeState` against the three expected JSON files under the same
//! directory.
//!
//! # Fixture authoring
//!
//! See `crates/quanta-vt/tests/compat/README.md` for the full workflow. In
//! short, to add a new fixture:
//!
//! 1. Create `crates/quanta-vt/tests/compat/<name>/` with `input.pty` and
//!    `scenario.md`.
//! 2. Run `QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness`
//!    — the harness writes the expected JSONs from the live engine.
//! 3. Inspect the blessed files. If they match your intent, commit.
//! 4. Add the fixture name to `FIXTURES` below.
//!
//! # Gap reports
//!
//! On any mismatch the harness writes
//! `compat-gap/<program>_<timestamp>.report` in the repo root and
//! `panic!`s. See `compat-gap/README.md` for triage workflow.
//!
//! # Scope
//!
//! This harness uses only the public `quanta-vt` API + `serde_json` +
//! `std::fs` + `std::time`. No `chrono` / `uuid` / network / tokio. The
//! timestamp in a gap report is seconds-since-epoch (plain `u64`), which
//! keeps the dep list narrow per EPIC-G DoD 5.8 "harness imports only
//! `quanta-vt` + `serde_json`; no I/O crates besides `std::fs`".

#![allow(
    clippy::expect_used,
    clippy::panic,
    reason = "test harness — expect/panic is the right signal"
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use quanta_vt::{CursorPayload, Grid, GridSnapshot, TerminalEvent, TerminalModeState};
use quanta_vt_width::{AmbiguousWidthPolicy, DefaultClassifier, WidthClassifier};
use serde::Serialize;

/// The list of hand-curated synthetic compat fixtures replayed by this
/// harness. These are the six initial-pass scenarios; real-program
/// recordings are auto-discovered at test-run time by
/// [`discover_recorded_fixtures`] so the hand-list doesn't need to grow
/// for every captured binary.
const FIXTURES: &[&str] = &[
    "hello_world",
    "bold_text",
    "wrap_korean",
    "alt_screen_enter_exit",
    "cursor_save_restore",
    "scroll_region",
];

/// Auto-discover every subdirectory of `tests/compat/` that is NOT one
/// of the synthetic fixtures above and does NOT carry a `skip.marker`
/// file. These are the real-program recordings produced by the
/// `fixtures_programmatic` recorder (`QUANTA_RECORD_COMPAT=1 cargo test
/// -p quanta-integration-tests --test fixtures_programmatic`).
///
/// Returns the list of fixture names in sorted order so failure output
/// is deterministic.
fn discover_recorded_fixtures() -> Vec<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/compat");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip the hand-curated synthetics — they're driven by explicit
        // `#[test]` functions below so CI reports one named pass/fail
        // per synthetic.
        if FIXTURES.contains(&name) {
            continue;
        }
        // A `skip.marker` means the recorder could not capture this
        // fixture on the capture host (program not installed, etc.).
        if path.join("skip.marker").exists() {
            continue;
        }
        // Must have the five required files to be a valid fixture.
        if !path.join("input.pty").exists() {
            continue;
        }
        out.push(name.to_string());
    }
    out.sort();
    out
}

/// Grid geometry used by every fixture. Pinned to the RFC §13.9 capture
/// environment (24 rows × 80 cols).
const ROWS: u16 = 24;
const COLS: u16 = 80;
const SCROLLBACK: usize = 10_000;

fn classifier() -> Arc<dyn WidthClassifier> {
    Arc::new(DefaultClassifier::new(AmbiguousWidthPolicy::Narrow))
}

fn fixture_dir(program: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/compat")
        .join(program)
}

fn compat_gap_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` = `.../crates/quanta-vt`. Two levels up lands us
    // at the repo root, where `compat-gap/` lives per EPIC-G §3.2.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("compat-gap")
}

/// Result of running a fixture through the engine.
struct ReplayOutcome {
    program: String,
    input_len: usize,
    event_count: usize,
    grid: GridSnapshot,
    cursor: CursorPayload,
    modes: TerminalModeState,
}

/// Feed `input.pty` through a fresh grid and capture the end-of-feed state.
fn replay(program: &str) -> ReplayOutcome {
    let dir = fixture_dir(program);
    let input_path = dir.join("input.pty");
    let input =
        fs::read(&input_path).unwrap_or_else(|e| panic!("read {}: {e}", input_path.display()));

    let mut grid = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    // Feed in a single chunk. Chunk-splitting is covered by
    // `crates/quanta-vt/tests/grapheme.rs` etc.; here we want the total
    // end-state under a plain `feed()`.
    let events: Vec<TerminalEvent> = grid.feed(&input);

    let snapshot = grid.snapshot();
    let cursor = snapshot.cursor;
    let modes = snapshot.modes;

    ReplayOutcome {
        program: program.to_string(),
        input_len: input.len(),
        event_count: events.len(),
        grid: snapshot,
        cursor,
        modes,
    }
}

/// Read and decode a JSON file that is expected to exist. Panics with the
/// fixture path on failure so a missing/malformed golden produces an
/// actionable test failure rather than a serde error deep in the stack.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let raw = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {} as JSON: {e}", path.display()))
}

/// Pretty-print a serializable value as canonical JSON. Sorted keys are NOT
/// applied (serde_json preserves struct field order, and we rely on the
/// derived `Serialize` impls being stable between runs); what matters is
/// that the blessed output round-trips through `serde_json::from_str` into
/// the same Rust value, which `assert_eq!` validates cell-by-cell.
fn to_pretty_json<T: Serialize>(value: &T) -> String {
    let mut s = serde_json::to_string_pretty(value).expect("serialize");
    s.push('\n');
    s
}

/// Write the three expected JSON files from a live replay outcome. Used by
/// the `QUANTA_VT_BLESS=1` path when adding or updating a fixture.
fn bless_outcome(outcome: &ReplayOutcome) {
    let dir = fixture_dir(&outcome.program);
    fs::write(
        dir.join("expected_grid_snapshot.json"),
        to_pretty_json(&outcome.grid),
    )
    .expect("write expected_grid_snapshot.json");
    fs::write(
        dir.join("expected_cursor.json"),
        to_pretty_json(&outcome.cursor),
    )
    .expect("write expected_cursor.json");
    fs::write(
        dir.join("expected_modes.json"),
        to_pretty_json(&outcome.modes),
    )
    .expect("write expected_modes.json");
}

/// Item in a gap report's `diffs` array. Schema pinned in
/// `compat-gap/TEMPLATE.md` and matches EPIC-G plan §4.5.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Diff {
    Cell {
        row: u16,
        col: u16,
        expected: serde_json::Value,
        actual: serde_json::Value,
    },
    ContinuationFlag {
        row: u16,
        expected: bool,
        actual: bool,
    },
    Cursor {
        expected: serde_json::Value,
        actual: serde_json::Value,
    },
    Modes {
        expected: serde_json::Value,
        actual: serde_json::Value,
    },
    GridShape {
        expected_rows: u16,
        expected_cols: u16,
        actual_rows: u16,
        actual_cols: u16,
    },
    BufferKind {
        expected: serde_json::Value,
        actual: serde_json::Value,
    },
}

#[derive(Debug, Serialize)]
struct FixtureMeta {
    input_len_bytes: usize,
    event_count: usize,
}

#[derive(Debug, Serialize)]
struct GapReport {
    schema_version: u32,
    program: String,
    scenario: String,
    timestamp_utc: String,
    harness: &'static str,
    engine_commit_sha: String,
    fixture: FixtureMeta,
    diffs: Vec<Diff>,
    versions_md_excerpt: String,
}

fn unix_timestamp_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn format_unix_timestamp(ts: u64) -> String {
    // Intentionally minimal — we avoid `chrono` to keep the dep surface
    // narrow per EPIC-G DoD 5.8. Downstream operators will inspect the
    // numeric stamp + the file-system mtime if they need a human-friendly
    // date.
    format!("unix:{ts}")
}

fn engine_commit_sha() -> String {
    std::env::var("QUANTA_VT_COMMIT_SHA")
        .or_else(|_| std::env::var("GITHUB_SHA"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn versions_md_excerpt() -> String {
    let path = fixture_dir("")
        .parent()
        .map(|p| p.join("compat/VERSIONS.md"))
        .unwrap_or_else(|| PathBuf::from("VERSIONS.md"));
    fs::read_to_string(&path).unwrap_or_else(|_| "VERSIONS.md unavailable".to_string())
}

/// Convert a serializable value to a `serde_json::Value` for embedding in a
/// `Diff`. Panics on serialize failure — our types all `derive(Serialize)`.
fn to_value<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).expect("to_value")
}

/// Build the per-cell / per-row diff list between expected and actual grid
/// snapshots. Short-circuits on shape mismatch (different row/col counts)
/// to give the operator a single actionable signal rather than a flood of
/// cell diffs.
fn diff_grids(expected: &GridSnapshot, actual: &GridSnapshot) -> Vec<Diff> {
    let mut out = Vec::new();

    if expected.rows != actual.rows || expected.cols != actual.cols {
        out.push(Diff::GridShape {
            expected_rows: expected.rows,
            expected_cols: expected.cols,
            actual_rows: actual.rows,
            actual_cols: actual.cols,
        });
        return out;
    }

    if expected.buffer_kind != actual.buffer_kind {
        out.push(Diff::BufferKind {
            expected: to_value(&expected.buffer_kind),
            actual: to_value(&actual.buffer_kind),
        });
    }

    for row in 0..expected.rows as usize {
        // Continuation flag.
        let exp_cont = expected.continuations.get(row).copied().unwrap_or(false);
        let act_cont = actual.continuations.get(row).copied().unwrap_or(false);
        if exp_cont != act_cont {
            out.push(Diff::ContinuationFlag {
                row: row as u16,
                expected: exp_cont,
                actual: act_cont,
            });
        }

        // Cells.
        let exp_row = &expected.cells[row];
        let act_row = &actual.cells[row];
        for col in 0..expected.cols as usize {
            if exp_row[col] != act_row[col] {
                out.push(Diff::Cell {
                    row: row as u16,
                    col: col as u16,
                    expected: to_value(&exp_row[col]),
                    actual: to_value(&act_row[col]),
                });
            }
        }
    }

    out
}

fn diff_cursor(expected: CursorPayload, actual: CursorPayload) -> Option<Diff> {
    if expected == actual {
        None
    } else {
        Some(Diff::Cursor {
            expected: to_value(&expected),
            actual: to_value(&actual),
        })
    }
}

fn diff_modes(expected: TerminalModeState, actual: TerminalModeState) -> Option<Diff> {
    if expected == actual {
        None
    } else {
        Some(Diff::Modes {
            expected: to_value(&expected),
            actual: to_value(&actual),
        })
    }
}

/// Write a gap report on mismatch. Uses `compat-gap/<program>_<ts>.report`
/// per EPIC-G §4.5 schema. The `.report` extension keeps these out of git
/// via `compat-gap/.gitignore`.
fn write_gap_report(report: &GapReport) {
    let dir = compat_gap_dir();
    let _ = fs::create_dir_all(&dir);
    let fname = format!("{}_{}.report", report.program, unix_timestamp_s());
    let path = dir.join(fname);
    let body = serde_json::to_string_pretty(report).expect("serialize report");
    // If the write fails (e.g., running on a read-only mount), we still
    // want the test to fail with a readable panic; swallow the write error
    // so the panic message below is the dominant signal.
    let _ = fs::write(&path, body);
    eprintln!("compat-gap report written: {}", path.display());
}

/// Core assertion path. On mismatch, writes a gap report and panics.
fn assert_fixture_matches(program: &str) {
    let outcome = replay(program);
    let dir = fixture_dir(program);
    let expected_grid: GridSnapshot = read_json(&dir.join("expected_grid_snapshot.json"));
    let expected_cursor: CursorPayload = read_json(&dir.join("expected_cursor.json"));
    let expected_modes: TerminalModeState = read_json(&dir.join("expected_modes.json"));

    let mut diffs = diff_grids(&expected_grid, &outcome.grid);
    if let Some(d) = diff_cursor(expected_cursor, outcome.cursor) {
        diffs.push(d);
    }
    if let Some(d) = diff_modes(expected_modes, outcome.modes) {
        diffs.push(d);
    }

    if diffs.is_empty() {
        return;
    }

    let report = GapReport {
        schema_version: 1,
        program: program.to_string(),
        scenario: program.to_string(),
        timestamp_utc: format_unix_timestamp(unix_timestamp_s()),
        harness: "replay",
        engine_commit_sha: engine_commit_sha(),
        fixture: FixtureMeta {
            input_len_bytes: outcome.input_len,
            event_count: outcome.event_count,
        },
        diffs,
        versions_md_excerpt: versions_md_excerpt(),
    };
    write_gap_report(&report);

    panic!(
        "compat fixture `{program}` diverged; see compat-gap/{}_<ts>.report",
        program
    );
}

/// Dispatch per fixture. Honors `QUANTA_VT_BLESS=1` by writing the three
/// expected JSON files from the current engine's output rather than
/// comparing.
fn run_fixture(program: &str) {
    // Assert the fixture directory exists so a typo surfaces as a clean
    // panic rather than a downstream `read_json` failure.
    let dir = fixture_dir(program);
    assert!(dir.exists(), "fixture directory missing: {}", dir.display(),);
    assert!(
        dir.join("input.pty").exists(),
        "fixture missing input.pty: {}",
        dir.display(),
    );

    if std::env::var_os("QUANTA_VT_BLESS").is_some() {
        let outcome = replay(program);
        bless_outcome(&outcome);
        eprintln!("blessed fixture `{program}`");
        return;
    }

    assert_fixture_matches(program);
}

// -----------------------------------------------------------------------
// Per-fixture test entry points. One `#[test] fn compat_<name>()` each so
// CI reports one pass/fail per fixture.
// -----------------------------------------------------------------------

#[test]
fn compat_hello_world() {
    run_fixture("hello_world");
}

#[test]
fn compat_bold_text() {
    run_fixture("bold_text");
}

#[test]
fn compat_wrap_korean() {
    run_fixture("wrap_korean");
}

#[test]
fn compat_alt_screen_enter_exit() {
    run_fixture("alt_screen_enter_exit");
}

#[test]
fn compat_cursor_save_restore() {
    run_fixture("cursor_save_restore");
}

#[test]
fn compat_scroll_region() {
    run_fixture("scroll_region");
}

/// Auto-discovered real-program fixtures. One test invocation that
/// iterates every recorded fixture found on disk at test-run time;
/// this keeps the harness fixture-agnostic (drop files into the
/// compat tree → they run) while still giving a single named
/// pass/fail in CI output.
///
/// Failures within this loop short-circuit on the first mismatch
/// because each fixture writes its own gap report and then panics
/// via the shared `assert_fixture_matches` helper.
#[test]
fn compat_recorded_fixtures() {
    let recorded = discover_recorded_fixtures();
    if recorded.is_empty() {
        eprintln!(
            "compat_recorded_fixtures: no recorded fixtures present. \
Run `QUANTA_RECORD_COMPAT=1 cargo test -p quanta-integration-tests --test fixtures_programmatic` \
to capture some.",
        );
        return;
    }
    eprintln!(
        "compat_recorded_fixtures: replaying {} fixture(s): {:?}",
        recorded.len(),
        recorded,
    );
    for name in &recorded {
        run_fixture(name);
    }
}

// -----------------------------------------------------------------------
// Harness self-test — validates the machinery even if every fixture is
// deleted. Feeds a trivially-known input (`"hi"`) and asserts end-state.
// -----------------------------------------------------------------------

#[test]
fn harness_self_test_synthetic_pipeline() {
    let mut grid = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let events = grid.feed(b"hi");
    assert!(!events.is_empty(), "engine must emit at least one event");
    let snap = grid.snapshot();
    assert_eq!(snap.rows, ROWS);
    assert_eq!(snap.cols, COLS);
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "h");
    assert_eq!(snap.cells[0][1].grapheme.as_str(), "i");
    // Round-trip the snapshot through JSON to validate serde parity — the
    // harness relies on this for all blessed goldens.
    let j = serde_json::to_string(&snap).expect("serialize snapshot");
    let round: GridSnapshot = serde_json::from_str(&j).expect("deserialize snapshot");
    assert_eq!(snap, round);
}

#[test]
fn harness_diff_grids_detects_mismatch() {
    let mut g1 = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _ = g1.feed(b"A");
    let mut g2 = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _ = g2.feed(b"B");
    let d = diff_grids(&g1.snapshot(), &g2.snapshot());
    assert!(
        d.iter().any(|d| matches!(d, Diff::Cell { .. })),
        "expected a cell diff between distinct outputs",
    );
}

#[test]
fn harness_diff_grids_no_diff_on_equal() {
    let mut g1 = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _ = g1.feed(b"same");
    let mut g2 = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _ = g2.feed(b"same");
    let d = diff_grids(&g1.snapshot(), &g2.snapshot());
    assert!(d.is_empty(), "equal grids must produce no diffs");
}

#[test]
fn harness_all_fixtures_have_required_files() {
    // When running under QUANTA_VT_BLESS, the expected_*.json files are
    // intentionally being (re)written — skip the existence check so a
    // first-time bless can run cleanly.
    if std::env::var_os("QUANTA_VT_BLESS").is_some() {
        return;
    }
    let required = [
        "input.pty",
        "scenario.md",
        "expected_grid_snapshot.json",
        "expected_cursor.json",
        "expected_modes.json",
    ];
    for name in FIXTURES {
        let dir = fixture_dir(name);
        for f in required {
            assert!(
                dir.join(f).exists(),
                "fixture `{name}` missing required file `{f}`",
            );
        }
    }
    // Auto-discovered recorded fixtures must also be complete — an
    // incomplete subdir should either (a) have a skip.marker, in which
    // case `discover_recorded_fixtures` filters it out, or (b) be
    // absent entirely. Anything with an input.pty but missing goldens
    // is a bug in the recorder.
    for name in discover_recorded_fixtures() {
        let dir = fixture_dir(&name);
        for f in required {
            assert!(
                dir.join(f).exists(),
                "recorded fixture `{name}` missing required file `{f}`",
            );
        }
    }
}
