//! EPIC-G — Scripted interactive compat runner.
//!
//! Spawns a real child process under a PTY, feeds scripted keystrokes,
//! reads back the output stream, and asserts grid state by re-feeding the
//! bytes through a fresh `quanta_vt::Grid`. Complements the golden-replay
//! harness (`crates/quanta-vt/tests/compat_harness.rs`) — where replay
//! exercises bytes-in-JSON-out, the scripted runner exercises
//! program-in-bytes-out-grid-out.
//!
//! # Scope of this implementation pass
//!
//! - One **working** test: `scripted_bash_echo_hi`. Runs `bash -c 'echo hi;
//!   exit 0'`, reads the PTY output, feeds it through a `Grid`, and asserts
//!   `hi` lands on row 0. Demonstrates the spawn / feed / assert pattern
//!   end-to-end and serves as the canary.
//! - `#[ignore]`'d stubs for each of the 14 MUST programs in
//!   `docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md`
//!   §3.1. Each stub carries a TODO block with the scenario steps lifted
//!   from the plan's §4.4. A follow-up pass lifts one stub at a time into
//!   a working test by adding the keystroke / observation logic.
//!
//! # Why not the full session actor?
//!
//! EPIC-G §4.3 specifies the full stack path (real PTY → session actor →
//! engine → GridMirror). That path depends on EPIC-F's session actor
//! plumbing + EPIC-E's input encoder, and this pass's scope (per agent
//! task) is "skeleton that spawns a child process + feeds keystrokes via
//! `portable_pty` + asserts grid state". We use `portable_pty` directly so
//! the scripted runner works today without waiting for the actor's test
//! harness. Upgrading to the full-stack wiring is a one-file change: swap
//! `ScriptedRunner::spawn` from `portable_pty::PtySystem::openpty` to
//! `quanta_session::actor::Actor::new` and sink events from the actor's
//! fanout — the assertion surface stays the same.
//!
//! # Gap reports
//!
//! On any scripted-runner mismatch, the runner writes
//! `compat-gap/<program>_scripted_<timestamp>.report` with the same schema
//! as the replay harness. See `compat-gap/README.md` for triage.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    dead_code,
    reason = "test harness — expect/panic is the right signal; stubs carry placeholder helpers"
)]

use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use quanta_vt::{Grid, GridSnapshot};
use quanta_vt_width::{AmbiguousWidthPolicy, DefaultClassifier, WidthClassifier};

// -----------------------------------------------------------------------
// ScriptedRunner — the test utility.
// -----------------------------------------------------------------------

/// Fixed 24×80 geometry for every scripted scenario (matches
/// `compat_harness.rs` and the RFC §13.9 capture environment).
const ROWS: u16 = 24;
const COLS: u16 = 80;
const SCROLLBACK: usize = 10_000;

/// Default deadline for any "wait until" assertion. Programs that need
/// longer should bump this per-test.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

fn classifier() -> Arc<dyn WidthClassifier> {
    Arc::new(DefaultClassifier::new(AmbiguousWidthPolicy::Narrow))
}

/// Minimal scripted runner. Owns a PTY, a grid, and a collector of raw
/// bytes read off the PTY master.
///
/// The reader runs on a dedicated pump thread that feeds a `mpsc::channel`.
/// This mirrors the real adapter in `crates/quanta-pty/src/adapters/portable.rs`
/// and avoids the "blocking read never returns" failure mode that caught
/// the naive synchronous version of this scaffold.
struct ScriptedRunner {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    rx: Receiver<Vec<u8>>,
    grid: Grid,
    /// Every byte read off the PTY master so far. Useful for post-mortem
    /// on a failing assertion.
    raw_bytes: Vec<u8>,
    /// Dropped on `Drop` so the pump thread tears down cleanly.
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl ScriptedRunner {
    /// Spawn a program under a PTY sized 24×80 and return a runner whose
    /// grid reflects the program's cumulative output.
    fn spawn(program: &str, args: &[&str]) -> Self {
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
        // Fixed env per RFC §13.9 §4.1. Some vars (HOME, PATH) are
        // inherited; tests that care about a fully clean env should
        // override.
        cmd.env("TERM", "xterm-256color");
        cmd.env("LINES", "24");
        cmd.env("COLUMNS", "80");
        cmd.env("TZ", "UTC");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).expect("spawn");
        // Dropping the slave end ensures the parent sees EOF when the
        // child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let writer = pair.master.take_writer().expect("take writer");
        let grid = Grid::new(ROWS, COLS, SCROLLBACK, classifier());

        // Pump thread: do the blocking read() off-thread and shovel
        // chunks into an mpsc channel. Terminates when read() returns
        // `0` (EOF, meaning the child closed the slave fd) or errors.
        let (tx, rx) = channel::<Vec<u8>>();
        thread::Builder::new()
            .name("compat-scripted-pump".into())
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
            grid,
            raw_bytes: Vec::new(),
        }
    }

    /// Send raw bytes to the program's stdin via the PTY master. Keystrokes
    /// are typically ASCII; control sequences are the caller's job to
    /// construct (the real harness would call into the EPIC-E input
    /// encoder).
    fn send_bytes(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("write to pty master");
        self.writer.flush().expect("flush pty master");
    }

    /// Drain bytes from the pump-thread channel into the grid.
    ///
    /// Polls the channel until no more bytes are available OR `budget`
    /// elapses. The pump thread closes its send end on EOF; once that
    /// happens subsequent `try_recv()` calls return `Disconnected` and
    /// this function returns immediately.
    fn drain_once(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        loop {
            match self.rx.try_recv() {
                Ok(chunk) => {
                    self.raw_bytes.extend_from_slice(&chunk);
                    let _ = self.grid.feed(&chunk);
                }
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

    /// Wait for the child to exit (up to `deadline`). Returns `true` if
    /// the child exited cleanly, `false` on timeout.
    fn wait_for_exit(&mut self, deadline: Duration) -> bool {
        let end = Instant::now() + deadline;
        while Instant::now() < end {
            match self.child.try_wait() {
                Ok(Some(_status)) => return true,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => return false,
            }
        }
        false
    }

    /// Snapshot the current grid state.
    fn snapshot(&self) -> GridSnapshot {
        self.grid.snapshot()
    }

    /// Assert a given string is present on `row`, anywhere in cols 0..cols.
    fn expect_grid_contains(&self, needle: &str, row: u16) {
        let snap = self.snapshot();
        let row_idx = row as usize;
        assert!(
            row_idx < snap.cells.len(),
            "row {row} out of range (snap has {} rows)",
            snap.cells.len(),
        );
        let joined: String = snap.cells[row_idx]
            .iter()
            .map(|c| c.grapheme.as_str())
            .collect();
        assert!(
            joined.contains(needle),
            "row {row} did not contain `{needle}`; got: `{}`",
            joined.trim_end(),
        );
    }
}

impl Drop for ScriptedRunner {
    fn drop(&mut self) {
        // Best-effort kill; we don't care if it's already gone.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// -----------------------------------------------------------------------
// Working canary test
// -----------------------------------------------------------------------

/// `bash -c 'echo hi; exit 0'` — the smallest working scripted scenario.
///
/// Demonstrates: spawn under PTY → wait for exit → drain bytes →
/// feed into `Grid` → assert grid state. If this test fails, the runner
/// itself is broken; the per-program stubs will not work either.
#[test]
fn scripted_bash_echo_hi() {
    // Pick a shell that exists on every supported host.
    let sh = if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };

    let mut runner = ScriptedRunner::spawn(sh, &["-c", "echo hi; exit 0"]);

    // The child exits almost immediately. Wait up to 5 s, then drain any
    // remaining bytes from the reader.
    let exited = runner.wait_for_exit(DEFAULT_TIMEOUT);
    assert!(
        exited,
        "bash -c 'echo hi' should exit within {DEFAULT_TIMEOUT:?}"
    );

    runner.drain_once(Duration::from_millis(500));

    // The shell's output includes "hi\r\n" (PTY translates LF → CRLF on
    // stdout). A trailing prompt isn't emitted since `-c` is non-
    // interactive. So row 0 should contain "hi".
    runner.expect_grid_contains("hi", 0);
}

// -----------------------------------------------------------------------
// Per-program stubs. Each #[ignore]'d test documents the scenario lifted
// from epic-G-compat-matrix.md §4.4. Removing the #[ignore] + filling in
// the keystroke / assertion block graduates the stub to a real test.
// -----------------------------------------------------------------------

#[test]
#[ignore = "vim requires a real vim binary and 90-min interactive dogfood per EPIC-G §5.7; follow-up pass"]
fn scripted_vim_insert_save_exit() {
    // TODO — EPIC-G §4.4.1 / E2E-G-vim (plan §7.1).
    //
    // Precondition: tempdir with an empty `hello.txt`.
    //
    // Steps:
    //   1. ScriptedRunner::spawn("vim", &["/tmp/hello.txt"])
    //   2. Assert alt-screen entered within 500 ms:
    //        assert_eq!(runner.snapshot().buffer_kind, BufferKind::Alt);
    //        assert!(runner.snapshot().modes.alt_screen);
    //   3. Assert ModeChanged(AltScreen, true) precedes first alt-buffer
    //      GridDelta (ordering invariant — retires RFC §22 #8).
    //   4. runner.send_bytes(b"i");              // insert mode
    //   5. runner.send_bytes(b"Hello, world!");
    //   6. runner.send_bytes(b"\x1b");           // ESC to normal mode
    //   7. runner.expect_grid_contains("Hello, world!", 0);
    //   8. runner.send_bytes(b":wq\n");
    //   9. assert!(runner.wait_for_exit(Duration::from_secs(2)));
    //  10. Drain remaining bytes. Assert alt-screen exited:
    //        assert_eq!(runner.snapshot().buffer_kind, BufferKind::Main);
    //  11. File `hello.txt` contains exactly `Hello, world!\n`.
}

#[test]
#[ignore = "tmux requires a real tmux binary + passthrough-off scenario; follow-up pass"]
fn scripted_tmux_new_split() {
    // TODO — EPIC-G §4.4.4 / E2E-G-tmux (plan §7.4).
    //
    // Steps:
    //   1. Spawn `tmux new-session -s e2e`.
    //   2. Assert alt-screen entered.
    //   3. Assert status line at row 23.
    //   4. send_bytes(b"\x02%")    // C-b %: split vertically
    //   5. Assert vertical bar at col 40.
    //   6. send_bytes(b"PANE_TWO_HERE\n")
    //   7. expect_grid_contains("PANE_TWO_HERE", /* right pane row */)
    //   8. send_bytes(b"\x02o")    // C-b o: swap
    //   9. send_bytes(b"echo PANE_ONE\n")
    //  10. Both strings visible in their panes.
    //  11. send_bytes(b"\x02d")    // C-b d: detach
    //  12. Assert alt-screen exited.
    //  13. `tmux kill-server` cleanup.
}

#[test]
#[ignore = "htop requires a real htop binary + clock redaction; follow-up pass"]
fn scripted_htop_f10_exit() {
    // TODO — EPIC-G §4.4.3 / E2E-G-htop (plan §7.3).
    //
    // Steps:
    //   1. Spawn `htop`.
    //   2. Assert alt-screen entered.
    //   3. Assert at least one cell has truecolor fg in the header row.
    //   4. Assert mouse tracking enabled:
    //        runner.snapshot().modes.mouse_protocol != MouseProtocol::Off
    //   5. Wait 1 refresh tick (~1 s).
    //   6. send_bytes(b"\x1b[21~")   // F10  (legacy xterm)
    //   7. assert!(runner.wait_for_exit(Duration::from_secs(2)))
    //   8. Drain; assert alt-screen exited.
    //
    // Clock-row cells are "redacted-clock" in the scenario.md; the
    // scripted assertion only checks cells outside the clock column
    // range documented there.
}

#[test]
#[ignore = "less requires a real less binary + paged corpus setup; follow-up pass"]
fn scripted_less_quit() {
    // TODO — EPIC-G §4.4.2 / E2E-G-less (plan §7.2).
    //
    // Steps:
    //   1. Precondition: /tmp/paged.txt with 200 numbered lines.
    //   2. Spawn `less /tmp/paged.txt`.
    //   3. Assert alt-screen entered; row 0 contains "line 1".
    //   4. send_bytes(b" ")          // SPACE: page down
    //   5. expect row 0 contains "line 24" or "line 25" (version-pinned).
    //   6. send_bytes(b"/50\n")      // search "50"
    //   7. send_bytes(b"n")           // next match
    //   8. send_bytes(b"g")           // top
    //   9. send_bytes(b"G")           // bottom
    //  10. send_bytes(b"q")           // quit
    //  11. Assert alt-screen exited; main buffer unchanged.
}

#[test]
#[ignore = "nano requires a real nano binary + tempfile setup; follow-up pass"]
fn scripted_nano_edit_save() {
    // TODO — EPIC-G §4.4.7 / E2E-G-nano (plan §7.7).
    //
    // Steps:
    //   1. Spawn `nano /tmp/note.txt`.
    //   2. Assert alt-screen; bottom two rows show menu.
    //   3. send_bytes(b"hello nano")
    //   4. send_bytes(b"\x0f")        // C-o: WriteOut
    //   5. send_bytes(b"\n")          // accept filename
    //   6. send_bytes(b"\x18")        // C-x: exit
    //   7. Assert alt-screen exited.
    //   8. /tmp/note.txt contains "hello nano\n".
}

#[test]
#[ignore = "vim-in-tmux nested alt-screen depth-counter invariant; follow-up pass"]
fn scripted_vim_in_tmux() {
    // TODO — EPIC-G §4.4.5 / E2E-G-vim-in-tmux (plan §7.5).
    //
    // The single most important compat scenario per RFC §5. Asserts:
    //   - alt-screen depth counter goes to 2 when vim enters alt inside
    //     tmux (which is already in alt);
    //   - returns to 1 when vim exits;
    //   - returns to 0 on tmux detach.
    //
    // Steps:
    //   1. Spawn `tmux new-session -s e2e-vim`.
    //   2. Assert depth = 1.
    //   3. send_bytes(b"vim /tmp/nested.txt\n")
    //   4. Assert depth = 2.
    //   5. send_bytes(b"iNested hello!\x1b:wq\n")
    //   6. Assert depth = 1 after vim exits.
    //   7. send_bytes(b"\x02d")       // C-b d: detach
    //   8. Assert depth = 0.
    //   9. `tmux kill-server` cleanup.
    //  10. /tmp/nested.txt == "Nested hello!\n".
}

#[test]
#[ignore = "ssh-loopback requires sshd + passwordless keys; follow-up pass"]
fn scripted_ssh_loopback() {
    // TODO — EPIC-G §4.4.6 / E2E-G-ssh (plan §7.6).
    //
    // Test-skip guard: if `ssh localhost true` fails within 2 s, mark
    // `ignored` with `[SKIP] ssh unavailable`. DO NOT fail.
    //
    // Steps:
    //   1. `ssh localhost true`; if non-zero, return early with skip.
    //   2. Spawn `ssh -o StrictHostKeyChecking=no localhost`.
    //   3. Assert remote shell prompt.
    //   4. send_bytes(b"echo $TERM\n")
    //   5. expect "xterm-256color" in grid.
    //   6. send_bytes(b"vim /tmp/remote.txt\n")
    //   7. Assert alt-screen entered.
    //   8. send_bytes(b"iRemote hello!\x1b:wq\n")
    //   9. send_bytes(b"exit\n")
    //  10. Assert main-buffer prompt restored.
}

#[test]
#[ignore = "nvim distinct-from-vim entry; follow-up pass"]
fn scripted_nvim_edit_save() {
    // TODO — EPIC-G §4.4.10 / E2E-G-nvim (plan §7.10).
    //
    // Same as vim but with nvim. Byte streams differ (nvim's tui-v3
    // mode detection emits different alt-screen enter sequence);
    // observable end-state identical.
}

#[test]
#[ignore = "btop requires a real btop binary + truecolor cell assertions; follow-up pass"]
fn scripted_btop_quit() {
    // TODO — EPIC-G §4.4.11 / E2E-G-btop (plan §7.11).
    //
    // Spawn `btop`, assert alt-screen + at least one TrueColor fg cell,
    // wait 1 tick, send `q`, assert alt-screen exited.
}

#[test]
#[ignore = "top requires a real top binary + refresh-tick redaction; follow-up pass"]
fn scripted_top_quit() {
    // TODO — EPIC-G §4.4.12 / E2E-G-top (plan §7.11).
    //
    // Spawn `top -d 1` (override default 3 s refresh), assert alt-screen,
    // wait 1 tick, send `q`, assert alt-screen exited.
}

#[test]
#[ignore = "man requires a real man page available on the runner; follow-up pass"]
fn scripted_man_ls() {
    // TODO — EPIC-G §4.4.13 / E2E-G-man (plan §7.11).
    //
    // Spawn `man ls`. Assert row 0 contains "LS(1)". Send `q`.
    // Assert alt-screen exited.
}

#[test]
#[ignore = "mc requires a real mc binary; follow-up pass"]
fn scripted_mc_quit() {
    // TODO — EPIC-G §4.4.14 / E2E-G-mc (plan §7.11).
    //
    // Spawn `mc /tmp/ /tmp/`. Assert alt-screen + dual-panel.
    // Send F10 (CSI 21 ~). Expect confirmation dialog. Send `\n`.
    // Assert alt-screen exited.
}

#[test]
#[ignore = "ranger requires a real ranger binary + VISUAL integration; follow-up pass"]
fn scripted_ranger_navigate() {
    // TODO — EPIC-G §4.4.8 / E2E-G-ranger (plan §7.8).
    //
    // Spawn `ranger /tmp/rg/` with VISUAL=nano. `jj` to select third
    // file, `\n` to open with VISUAL, `C-x` to exit nano, `q` to quit.
}

#[test]
#[ignore = "ncmpcpp requires a real ncmpcpp binary (mpd connection optional); follow-up pass"]
fn scripted_ncmpcpp_quit() {
    // TODO — EPIC-G §4.4.9 / E2E-G-ncmpcpp (plan §7.9).
    //
    // Spawn `ncmpcpp`. Assert alt-screen + status bar at row 23.
    // Send `q`. Assert alt-screen exited.
}
