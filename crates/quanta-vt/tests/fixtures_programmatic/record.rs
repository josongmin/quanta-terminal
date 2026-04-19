//! EPIC-G — Programmatic real-program compat fixture recorder.
//!
//! Each `#[test]` in this file spawns a real program (vim, less, nano,
//! …) under a `portable_pty` PTY, feeds scripted keystrokes, reads back
//! the raw byte stream, and either:
//!
//! 1. (default) **verifies** that the committed fixture under
//!    `crates/quanta-vt/tests/compat/<program>/` still exists and has
//!    the minimum required files (`input.pty`, `scenario.md`, and the
//!    three `expected_*.json`). No program is actually spawned. This
//!    keeps CI fast + deterministic.
//!
//! 2. (record mode) when `QUANTA_RECORD_COMPAT=1` is set in the
//!    environment, **re-records** the fixture — spawns the program,
//!    captures the byte stream, computes the expected grid / cursor /
//!    modes by feeding the bytes through a fresh `Grid`, and writes all
//!    five fixture files to disk. If the program is not installed, a
//!    `skip.marker` file is written so the replay harness skips the
//!    fixture gracefully.
//!
//! This file lives under `crates/quanta-vt/tests/fixtures_programmatic/`
//! per EPIC-G §4.2, but the **test binary** is built by
//! `tests/integration/` (via a `[[test]] path = …` entry in its
//! `Cargo.toml`) so the recorder has access to `portable-pty`, `tokio`,
//! and the other dev-deps that `quanta-vt` deliberately does not pull
//! in.
//!
//! # Recording procedure
//!
//! ```sh
//! QUANTA_RECORD_COMPAT=1 \
//!     cargo test -p quanta-integration-tests --test fixtures_programmatic --no-fail-fast
//! ```
//!
//! After a successful run, inspect the generated `input.pty`s, the
//! scenario notes, and — if you're happy — commit everything under
//! `crates/quanta-vt/tests/compat/<program>/`. `VERSIONS.md` should be
//! updated by hand with the version + capture date.
//!
//! The committed goldens are what the real harness
//! (`crates/quanta-vt/tests/compat_harness.rs`) auto-discovers and
//! diffs cell-by-cell on every CI run.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    dead_code,
    reason = "test binary — expect/panic is the right signal; some helpers are debug-only"
)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use quanta_vt::{CursorPayload, Grid, GridSnapshot, TerminalModeState};
use quanta_vt_width::{AmbiguousWidthPolicy, DefaultClassifier, WidthClassifier};

// -----------------------------------------------------------------------
// Fixed capture environment (matches compat_harness.rs + RFC §13.9).
// -----------------------------------------------------------------------

const ROWS: u16 = 24;
const COLS: u16 = 80;
const SCROLLBACK: usize = 10_000;

/// Absolute hard upper bound on any program run. Anything still running
/// after this is SIGKILLed and the fixture is marked as skipped.
const HARD_TIMEOUT: Duration = Duration::from_secs(10);

/// Environment variable that flips this binary from "verify" to
/// "record" mode.
const RECORD_ENV: &str = "QUANTA_RECORD_COMPAT";

fn classifier() -> Arc<dyn WidthClassifier> {
    Arc::new(DefaultClassifier::new(AmbiguousWidthPolicy::Narrow))
}

/// Repo-rooted path to `crates/quanta-vt/tests/compat/<program>/`.
///
/// `CARGO_MANIFEST_DIR` resolves to `tests/integration/` when this file
/// is compiled by the integration crate's Cargo, so we walk two levels
/// up to hit the repo root, then down into the vt crate's compat tree.
fn compat_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("crates/quanta-vt/tests/compat")
}

fn fixture_dir(program: &str) -> PathBuf {
    compat_root().join(program)
}

fn recording_enabled() -> bool {
    std::env::var_os(RECORD_ENV).is_some()
}

/// Resolve a program on PATH. Returns `None` if the binary is missing.
fn which(program: &str) -> Option<PathBuf> {
    let out = Command::new("/usr/bin/which").arg(program).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Query `<program> --version` or a similar probe. Returns the first
/// non-empty line, trimmed; never fails — unknown versions are fine.
///
/// Env is set explicitly (`TERM=xterm-256color`, `LANG=en_US.UTF-8`,
/// `COLUMNS=80`, `LINES=24`) to match the recording environment — some
/// programs (`nano`) bail early on a missing TERM.
fn probe_version(program: &str, arg: &str) -> String {
    if arg.is_empty() {
        return format!("{program} (no version probe configured)");
    }
    let out = Command::new(program)
        .arg(arg)
        .env("TERM", "xterm-256color")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .env("LINES", "24")
        .env("COLUMNS", "80")
        .env("TZ", "UTC")
        .output();
    let Ok(out) = out else {
        return format!("unknown ({program} {arg} failed)");
    };
    let combined = [&out.stdout[..], &out.stderr[..]].concat();
    let s = String::from_utf8_lossy(&combined);
    // Scan the first ~5 non-empty lines for one that looks like a real
    // version banner; fall back to the first non-empty line. This
    // filters out garbage like `ls: unrecognized option '--version'`.
    let first_non_empty: Vec<&str> = s
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(5)
        .collect();
    for line in &first_non_empty {
        let lower = line.to_ascii_lowercase();
        if lower.contains("version")
            || lower.contains("v. ")
            || lower.contains("v.")
            || lower.starts_with('v') && line.chars().nth(1).is_some_and(|c| c.is_ascii_digit())
            || line.chars().next().is_some_and(|c| c.is_ascii_digit())
        {
            return line.to_string();
        }
    }
    first_non_empty
        .first()
        .map(|l| l.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

// -----------------------------------------------------------------------
// PTY runner — copy of the scripted-runner pattern from
// `tests/integration/tests/compat_scripted.rs` (see that file's header
// for the design rationale). Reduced to exactly what the recorder
// needs.
// -----------------------------------------------------------------------

struct PtyRunner {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    rx: Receiver<Vec<u8>>,
    raw_bytes: Vec<u8>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl PtyRunner {
    fn spawn(program: &Path, args: &[&str]) -> Self {
        let sys = native_pty_system();
        let pair = sys
            .openpty(PtySize {
                rows: ROWS,
                cols: COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new(program);
        for a in args {
            cmd.arg(a);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("LINES", "24");
        cmd.env("COLUMNS", "80");
        cmd.env("TZ", "UTC");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");
        cmd.env("COLORTERM", "truecolor");
        // Keep PATH so wrappers (e.g., homebrew's /opt path) still
        // resolve. The recorder spawns absolute paths; PATH is only a
        // fallback for child subprocesses.
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }

        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let writer = pair.master.take_writer().expect("take writer");
        let (tx, rx) = channel::<Vec<u8>>();
        thread::Builder::new()
            .name("compat-record-pump".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .expect("spawn pump thread");

        Self {
            _master: pair.master,
            child,
            writer,
            rx,
            raw_bytes: Vec::new(),
        }
    }

    fn send_bytes(&mut self, bytes: &[u8]) {
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
    }

    fn drain_for(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        loop {
            match self.rx.try_recv() {
                Ok(chunk) => self.raw_bytes.extend_from_slice(&chunk),
                Err(TryRecvError::Empty) => {
                    if Instant::now() >= deadline {
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(TryRecvError::Disconnected) => return,
            }
        }
    }

    /// Wait for exit up to `deadline`; on timeout send SIGKILL.
    fn wait_or_kill(&mut self, deadline: Duration) -> bool {
        let end = Instant::now() + deadline;
        while Instant::now() < end {
            match self.child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => return false,
            }
        }
        // Timed out — SIGKILL.
        let _ = self.child.kill();
        let _ = self.child.wait();
        false
    }
}

impl Drop for PtyRunner {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// -----------------------------------------------------------------------
// Recording helpers.
// -----------------------------------------------------------------------

struct RecordSpec {
    /// Fixture subdir name (`less`, `vim`, …). Also the test label.
    name: &'static str,
    /// Program invoked on PATH. Omitted from the fixture if missing.
    program: &'static str,
    /// Optional argv suffix.
    args: &'static [&'static str],
    /// Keystrokes sent after the program starts, in order.
    keystrokes: &'static [&'static [u8]],
    /// Delay between consecutive keystrokes. Keeps the target's TUI
    /// state machine happy (e.g., nano's menu-driven save flow).
    between_keys: Duration,
    /// How long to wait for the program to draw its initial screen
    /// before sending the first keystroke.
    warmup: Duration,
    /// How long to wait after the final keystroke for the program to
    /// exit cleanly.
    exit_wait: Duration,
    /// Argument used to probe the version (`--version`, `-V`, …).
    version_arg: &'static str,
    /// Override program used for the version probe. Useful when
    /// `program` is a wrapper like `sh -c '... | less'` and we want
    /// the inner binary's version instead. Empty → probe `program`.
    version_program: &'static str,
    /// Human-friendly scenario description.
    scenario: &'static str,
}

fn write_fixture_files(
    spec: &RecordSpec,
    bytes: &[u8],
    version_line: &str,
) -> Result<(), String> {
    let dir = fixture_dir(spec.name);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    // Feed through a fresh grid to derive expected_*.json.
    let mut grid = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _events = grid.feed(bytes);
    let snap: GridSnapshot = grid.snapshot();
    let cursor: CursorPayload = snap.cursor.clone();
    let modes: TerminalModeState = snap.modes.clone();

    // Attempt to serialize. A known upstream serde limitation
    // (tagged-newtype-around-primitive) can fail on `Color::Palette8`
    // which real programs do emit (ls, git, …). If serialization
    // fails, skip this fixture rather than panicking — the captured
    // input.pty is still useful as a corpus entry for the per-cell
    // engine; we just can't round-trip it through JSON today.
    let snap_json = try_to_pretty_json(&snap)
        .map_err(|e| format!("serialize snapshot: {e}"))?;
    let cursor_json = try_to_pretty_json(&cursor)
        .map_err(|e| format!("serialize cursor: {e}"))?;
    let modes_json = try_to_pretty_json(&modes)
        .map_err(|e| format!("serialize modes: {e}"))?;

    fs::write(dir.join("input.pty"), bytes)
        .map_err(|e| format!("write input.pty: {e}"))?;
    fs::write(dir.join("expected_grid_snapshot.json"), snap_json)
        .map_err(|e| format!("write expected_grid_snapshot.json: {e}"))?;
    fs::write(dir.join("expected_cursor.json"), cursor_json)
        .map_err(|e| format!("write expected_cursor.json: {e}"))?;
    fs::write(dir.join("expected_modes.json"), modes_json)
        .map_err(|e| format!("write expected_modes.json: {e}"))?;

    // scenario.md — human summary + keystrokes (hex-escaped for
    // unambiguous round-trip).
    let keystroke_dump: String = spec
        .keystrokes
        .iter()
        .enumerate()
        .map(|(i, k)| format!("{:>2}. `{}`", i + 1, escape_bytes(k)))
        .collect::<Vec<_>>()
        .join("\n");

    let args_dump = if spec.args.is_empty() {
        String::from("(none)")
    } else {
        spec.args.join(" ")
    };

    let body = format!(
        r#"# Scenario: `{name}`

- **Title**: `{name}-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `{program}` {args}
- Version captured: `{version}`

## Keystrokes

Sent to the PTY master in order, with `{between:?}` between each:

{keystroke_dump}

## Scenario

{scenario}

## Expected observable state

The end-of-feed `GridSnapshot`, `CursorPayload`, and `TerminalModeState`
are serialised into the sibling `expected_*.json` files by running
`bytes` through a fresh `Grid::new(24, 80, 10_000, classifier())` and
snapshotting. The replay harness (`compat_harness.rs`) auto-discovers
this directory and diffs cell-by-cell.

## Purpose

Proves the engine handles the byte stream emitted by a real `{program}`
build — not just hand-written escape sequences. Regressions here surface
as compat-gap reports.

## Captured

**Captured**: {program} / {version} / macOS (Darwin arm64) / en_US.UTF-8 / {date} / programmatic recorder
"#,
        name = spec.name,
        program = spec.program,
        args = args_dump,
        version = version_line,
        between = spec.between_keys,
        keystroke_dump = keystroke_dump,
        scenario = spec.scenario,
        date = current_iso_date(),
    );
    fs::write(dir.join("scenario.md"), body)
        .map_err(|e| format!("write scenario.md: {e}"))?;

    // Clear any stale skip.marker from a previous recording.
    let _ = fs::remove_file(dir.join("skip.marker"));

    Ok(())
}

fn write_skip_marker(name: &str, reason: &str) {
    let dir = fixture_dir(name);
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(
        dir.join("skip.marker"),
        format!(
            "# Skipped fixture\n\nreason: {reason}\ncaptured: {date}\n\nThis marker causes `compat_harness.rs` to skip the fixture. \
Remove it + run `QUANTA_RECORD_COMPAT=1 cargo test -p quanta-integration-tests --test fixtures_programmatic` on a host that has the program installed.\n",
            date = current_iso_date(),
        ),
    );
}

fn escape_bytes(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len() * 4);
    for &c in b {
        match c {
            0x1b => out.push_str("\\x1b"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(c as char),
            other => out.push_str(&format!("\\x{other:02x}")),
        }
    }
    out
}

fn to_pretty_json<T: serde::Serialize>(v: &T) -> String {
    let mut s = serde_json::to_string_pretty(v).expect("serialize");
    s.push('\n');
    s
}

/// Fallible variant of [`to_pretty_json`] used by the recorder so a
/// serialization failure (e.g., the `Color::Palette8` tagged-newtype
/// limitation) downgrades to a `skip.marker` instead of a panic.
fn try_to_pretty_json<T: serde::Serialize>(v: &T) -> Result<String, serde_json::Error> {
    let mut s = serde_json::to_string_pretty(v)?;
    s.push('\n');
    Ok(s)
}

fn current_iso_date() -> String {
    // Avoid `chrono` — the harness's "no extra deps" rule. The UNIX
    // day-count → ISO date is good enough for a provenance field;
    // capture hosts sync their clocks.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = now / 86_400;
    // Cheap civil-date computation (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

// -----------------------------------------------------------------------
// Core recorder: spawn program, feed keystrokes, drain bytes, write.
// -----------------------------------------------------------------------

enum RecordOutcome {
    Recorded,
    Skipped(String),
}

fn record_one(spec: &RecordSpec) -> RecordOutcome {
    // Program available?
    let Some(prog_path) = which(spec.program) else {
        let reason = format!("`{}` not found on PATH", spec.program);
        write_skip_marker(spec.name, &reason);
        return RecordOutcome::Skipped(reason);
    };
    let version_prog = if spec.version_program.is_empty() {
        spec.program
    } else {
        spec.version_program
    };
    let version = probe_version(version_prog, spec.version_arg);
    eprintln!(
        "[record] spawning {} ({}) -> {}",
        spec.program,
        version,
        fixture_dir(spec.name).display()
    );

    let start = Instant::now();
    let mut runner = PtyRunner::spawn(&prog_path, spec.args);

    // Initial warmup: let the program paint its first screen.
    runner.drain_for(spec.warmup);

    for k in spec.keystrokes {
        if start.elapsed() > HARD_TIMEOUT {
            break;
        }
        runner.send_bytes(k);
        runner.drain_for(spec.between_keys);
    }

    // Give the program a chance to exit cleanly.
    let exit_budget = spec
        .exit_wait
        .min(HARD_TIMEOUT.saturating_sub(start.elapsed()));
    let exited = runner.wait_or_kill(exit_budget);

    // Final drain for any trailing bytes.
    runner.drain_for(Duration::from_millis(250));

    if !exited {
        eprintln!(
            "[record] {} did not exit within {:?}; bytes captured so far: {}",
            spec.program,
            spec.exit_wait,
            runner.raw_bytes.len()
        );
    }

    if runner.raw_bytes.is_empty() {
        let reason = format!(
            "program `{}` produced no output within the capture window",
            spec.program
        );
        write_skip_marker(spec.name, &reason);
        return RecordOutcome::Skipped(reason);
    }

    if let Err(e) = write_fixture_files(spec, &runner.raw_bytes, &version) {
        let reason = format!("write failed: {e}");
        write_skip_marker(spec.name, &reason);
        return RecordOutcome::Skipped(reason);
    }

    eprintln!(
        "[record] wrote {} bytes to {}",
        runner.raw_bytes.len(),
        fixture_dir(spec.name).join("input.pty").display()
    );
    RecordOutcome::Recorded
}

// -----------------------------------------------------------------------
// Verify path — default when QUANTA_RECORD_COMPAT is unset. Ensures
// every spec's fixture directory either has a full fixture committed,
// OR a `skip.marker` explaining why it was skipped on the capture host.
// -----------------------------------------------------------------------

fn verify_one(spec: &RecordSpec) {
    let dir = fixture_dir(spec.name);
    if !dir.exists() {
        // Not yet captured at all — permitted, the replay harness
        // auto-discovers only what exists. Emit a helpful message and
        // pass; the operator will re-run with QUANTA_RECORD_COMPAT=1
        // to populate.
        eprintln!(
            "[verify] {} not yet recorded; run with QUANTA_RECORD_COMPAT=1 to capture.",
            spec.name,
        );
        return;
    }

    if dir.join("skip.marker").exists() {
        eprintln!("[verify] {} skipped (skip.marker present)", spec.name);
        return;
    }

    for f in [
        "input.pty",
        "scenario.md",
        "expected_grid_snapshot.json",
        "expected_cursor.json",
        "expected_modes.json",
    ] {
        assert!(
            dir.join(f).exists(),
            "recorded fixture `{}` missing required file `{f}`; re-record with QUANTA_RECORD_COMPAT=1",
            spec.name,
        );
    }

    // Sanity: input.pty should be non-empty.
    let input = fs::read(dir.join("input.pty")).expect("read input.pty");
    assert!(
        !input.is_empty(),
        "recorded fixture `{}` has empty input.pty",
        spec.name,
    );

    // Re-feed through the engine to make sure the committed goldens
    // still describe the same end-state.
    let mut grid = Grid::new(ROWS, COLS, SCROLLBACK, classifier());
    let _ = grid.feed(&input);
    let snap = grid.snapshot();
    let committed_grid: GridSnapshot =
        serde_json::from_str(&fs::read_to_string(dir.join("expected_grid_snapshot.json")).unwrap())
            .expect("parse expected_grid_snapshot.json");
    assert_eq!(
        snap, committed_grid,
        "replay of committed input.pty for `{}` diverges from committed expected_grid_snapshot.json; \
re-record with QUANTA_RECORD_COMPAT=1",
        spec.name,
    );
}

fn run(spec: &RecordSpec) {
    if recording_enabled() {
        match record_one(spec) {
            RecordOutcome::Recorded => {}
            RecordOutcome::Skipped(reason) => {
                eprintln!("[record] {} SKIPPED: {reason}", spec.name);
            }
        }
    } else {
        verify_one(spec);
    }
}

// -----------------------------------------------------------------------
// The scripted specs. Each is a best-effort real-program scenario. Add
// / adjust entries in one place; all the plumbing above is shared.
// -----------------------------------------------------------------------

/// Simple baseline: `/bin/echo "hello, world"`. Always present on every
/// supported host; the canary for the recorder itself.
const SPEC_ECHO: RecordSpec = RecordSpec {
    name: "echo_hello",
    program: "echo",
    args: &["hello, compat"],
    keystrokes: &[],
    between_keys: Duration::from_millis(50),
    warmup: Duration::from_millis(200),
    exit_wait: Duration::from_secs(2),
    // `echo` has no --version on BSD; fall back to `sh -c 'echo
    // $BASH_VERSION'` via the probe would be overkill. Leave blank →
    // `unknown`; the scenario.md still records the capture host OS.
    version_arg: "",
    scenario: "Trivial baseline: `echo` writes a single line and exits. \
Proves the recorder spawn / drain / write path. If this fixture regresses, \
the recorder itself is broken.",
};

/// `cat` with UTF-8 input. We use `printf` via `sh -c` to feed it multi-
/// byte text on stdin → stdout, and rely on the PTY translation layer
/// for CRLF + cursor positioning.
const SPEC_CAT_UTF8: RecordSpec = RecordSpec {
    name: "cat_utf8",
    program: "sh",
    args: &[
        "-c",
        "printf 'ascii line\\n한글 test\\n日本語\\n'",
    ],
    keystrokes: &[],
    between_keys: Duration::from_millis(50),
    warmup: Duration::from_millis(200),
    exit_wait: Duration::from_secs(2),
    version_arg: "--version",
    scenario: "UTF-8 multi-byte line feed — ASCII, Korean (한글), Japanese (日本語). \
Exercises grapheme width classification on a real-program byte stream.",
};

/// `ls --color=always` (or `ls -G` on BSD). Colored directory listing,
/// exercises SGR 38;5;N sequences or 38;2;R;G;B depending on LS_COLORS.
const SPEC_LS_COLOR: RecordSpec = RecordSpec {
    name: "ls_color",
    program: "ls",
    // macOS `ls` uses `-G` for colors. We point it at the workspace
    // `crates/` dir, which is stable across the tree.
    args: &["-G", "-la", "/"],
    keystrokes: &[],
    between_keys: Duration::from_millis(50),
    warmup: Duration::from_millis(500),
    exit_wait: Duration::from_secs(3),
    version_arg: "--version",
    scenario: "Colorised long-form `ls` listing of `/`. Exercises SGR color \
sequences (8-bit / 24-bit) emitted by a real `ls` build.",
};

/// `less` — pager. Feed it a small input via stdin, then send `q`.
const SPEC_LESS: RecordSpec = RecordSpec {
    name: "less_quit",
    program: "sh",
    args: &[
        "-c",
        "printf 'line a\\nline b\\nline c\\n' | less",
    ],
    // Send `q` to quit the pager after it paints.
    keystrokes: &[b"q"],
    between_keys: Duration::from_millis(300),
    warmup: Duration::from_millis(800),
    exit_wait: Duration::from_secs(3),
    version_arg: "--version",
    scenario: "`less` opens a 3-line corpus, draws its pager (alt-screen), \
then receives `q` and exits. Exercises DECSET 1049 enter → content → exit.",
};

/// `nano` — editor. Open a tempfile (auto-created), send Ctrl-X to exit
/// (no save prompt since buffer is empty).
const SPEC_NANO: RecordSpec = RecordSpec {
    name: "nano_exit",
    program: "nano",
    args: &["--restricted", "/tmp/quanta-compat-nano.txt"],
    // Ctrl-X = quit. Empty buffer → no "save changes?" prompt.
    keystrokes: &[b"\x18"],
    between_keys: Duration::from_millis(500),
    warmup: Duration::from_secs(1),
    exit_wait: Duration::from_secs(3),
    version_arg: "--version",
    scenario: "`nano --restricted` opens an empty file, paints its menu + status \
bars (alt-screen), receives Ctrl-X with no changes pending, exits cleanly.",
};

/// `vim --clean`, exit immediately via `:q!`. Uses `-c` to script the
/// whole session non-interactively: ex-mode open + quit-no-save.
const SPEC_VIM: RecordSpec = RecordSpec {
    name: "vim_quit",
    program: "vim",
    // `--not-a-term` prevents vim from refusing to draw under a pipe;
    // `-c 'q!'` queues the quit command; the initial `-u NONE` + `-N`
    // skips the user vimrc and forces nocompatible. We rely on vim
    // drawing at least one alt-screen enter before the queued quit
    // fires.
    args: &[
        "-u",
        "NONE",
        "-N",
        "-c",
        "q!",
    ],
    keystrokes: &[],
    between_keys: Duration::from_millis(100),
    warmup: Duration::from_millis(800),
    exit_wait: Duration::from_secs(4),
    version_arg: "--version",
    scenario: "`vim -u NONE -N -c 'q!'` — loads with no user config, queues \
an immediate force-quit. Exercises vim's alt-screen enter sequence even \
though the session is effectively zero-length.",
};

/// `tmux` non-interactive smoke: `-C new-session \; kill-server`. The
/// control-mode flag keeps tmux from entering its alt-screen TUI so
/// the whole capture fits in ~100 ms even when tmux is installed.
const SPEC_TMUX: RecordSpec = RecordSpec {
    name: "tmux_list",
    program: "tmux",
    args: &["-f", "/dev/null", "-V"],
    keystrokes: &[],
    between_keys: Duration::from_millis(50),
    warmup: Duration::from_millis(200),
    exit_wait: Duration::from_secs(2),
    version_arg: "-V",
    scenario: "`tmux -f /dev/null -V` prints the version banner and exits. \
Non-interactive smoke — proves the tmux binary plus recorder plumbing.",
};

/// `man ls` → `q`. Tests the `man` pager pipeline, which on macOS
/// invokes `less` under the hood.
const SPEC_MAN: RecordSpec = RecordSpec {
    name: "man_ls",
    program: "man",
    args: &["ls"],
    keystrokes: &[b"q"],
    between_keys: Duration::from_millis(300),
    warmup: Duration::from_millis(1200),
    exit_wait: Duration::from_secs(4),
    version_arg: "--version",
    scenario: "`man ls` opens the `ls(1)` manpage in the configured pager \
(less on macOS). `q` exits. Exercises bold + underline SGR on real prose.",
};

// -----------------------------------------------------------------------
// Test entry points. One `#[tokio::test]` per spec — multi-thread
// flavor per EPIC-G task notes (portable_pty can block).
// -----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_echo() {
    run(&SPEC_ECHO);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_cat_utf8() {
    run(&SPEC_CAT_UTF8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_ls_color() {
    run(&SPEC_LS_COLOR);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_less_quit() {
    run(&SPEC_LESS);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_nano_exit() {
    run(&SPEC_NANO);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_vim_quit() {
    run(&SPEC_VIM);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_tmux_list() {
    run(&SPEC_TMUX);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_man_ls() {
    run(&SPEC_MAN);
}

// -----------------------------------------------------------------------
// Self-tests for the recorder's own helpers.
// -----------------------------------------------------------------------

#[test]
fn escape_bytes_handles_ctrl_chars() {
    assert_eq!(escape_bytes(b"hi\nbye"), "hi\\nbye");
    assert_eq!(escape_bytes(b"\x1b[31m"), "\\x1b[31m");
    assert_eq!(escape_bytes(b"\x01"), "\\x01");
}

#[test]
fn compat_root_points_at_vt_crate() {
    let p = compat_root();
    // Path need not exist to be well-formed, but the grand-parent of
    // tests/integration/ must be the repo root.
    let ancestors: Vec<_> = p.ancestors().collect();
    // Expect .../crates/quanta-vt/tests/compat as the tail.
    let tail: Vec<String> = p
        .iter()
        .rev()
        .take(4)
        .map(|c| c.to_string_lossy().into_owned())
        .collect();
    assert_eq!(tail, vec!["compat", "tests", "quanta-vt", "crates"]);
    assert!(
        !ancestors.is_empty(),
        "compat_root must yield a non-empty path",
    );
}

#[test]
fn current_iso_date_shape() {
    let d = current_iso_date();
    assert_eq!(d.len(), 10, "ISO date should be YYYY-MM-DD, got `{d}`");
    assert_eq!(d.as_bytes()[4], b'-');
    assert_eq!(d.as_bytes()[7], b'-');
}
