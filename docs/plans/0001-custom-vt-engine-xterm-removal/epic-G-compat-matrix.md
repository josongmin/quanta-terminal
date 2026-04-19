# EPIC-G — Compat Matrix + Golden Streams — Detailed Design

- **Status**: Design-ahead draft (Gear 3)
- **Date**: 2026-04-19
- **Scope owner**: EPIC-G spec agent
- **Phase**: 4
- **Duration**: ~1.5 weeks (8 working days)
- **Implements**: RFC 0001 §13.9, §13.10, §14.3, §14.4, §18 (testing strategy),
  §22 (catch-all for the 20 failure modes not yet retired by B/C/D/E/F).
- **Depends on**: EPIC-B (`Grid::feed`, `TerminalEvent`, `GridSnapshot`),
  EPIC-C (wire protocol + `GridMirror`), EPIC-D (renderer backend contract),
  EPIC-E (input encoder + `ModeSnapshot`), EPIC-F (session actor wiring).
- **Freezes**: golden-stream format, `compat-gap/<program>.report` schema,
  scripted scenario runner contract, `VERSIONS.md` tracking shape.
- **Out-of-scope**: block chrome / alt-screen UX (EPIC-H), xterm removal
  (EPIC-I), perf-harness (EPIC-J), CI runners (EPIC-K — hosts the jobs but
  fixture corpus layout is owned here).

This document enumerates every compat program in the RFC §13.9 MUST set,
the harness that replays them, the scripted interactive scenarios that
exercise the full engine + session + renderer stack, and the `compat-gap/`
gap-reporting workflow. No Rust or TS under `crates/` or `packages/` is
touched by this plan; it produces the fixture tree and the harness
skeleton that EPIC-G implementation will code against.

---

## 1. Summary

**Goal**: Record golden PTY byte streams for every compat MUST program
listed in RFC §13.9; record a human-readable scenario description, an
expected grid snapshot, an expected cursor state, and an expected mode
state for each. Add a Rust harness that replays those bytes through
`quanta-vt::Grid` and byte-for-byte compares the final state. Add a
scripted interactive runner that launches each real program under a PTY,
sends keystrokes, and observes the grid through the full
`quanta-session` + `quanta-vt` + `quanta-proto` + `GridMirror` stack.
Any mismatch produces a `compat-gap/<program>_<timestamp>.report` which
blocks Phase 6 (xterm removal, EPIC-I) until resolved.

**Phase**: 4. **Duration**: ~1.5 weeks.

**Dependencies**: B + C + D + E + F. Everything upstream must work;
compat is the catch-all that catches "program X broke under our engine"
after all the unit tests are green.

**Contracts frozen here** (consumed by EPIC-H's side-by-side harness):

- Directory layout: `crates/quanta-vt/tests/compat/<program>/`
- File names: `input.pty`, `scenario.md`, `expected_grid_snapshot.json`,
  `expected_cursor.json`, `expected_modes.json`.
- `compat-gap/<program>_<timestamp>.report` schema (see §4.5).
- `scripts/record-compat-stream.sh` environment contract (§4.1).

## 2. Background

### 2.1 What RFC §13.9 requires

RFC §13.9 is a checkbox table of compat-MUST programs:

- `vim` / `nvim` (normal, insert, `:split`, `:term`, `:%s`, visual,
  `"*p`, NerdTree, fzf.vim)
- `less` (up/down/space/`/`/n/N/g/G/q)
- `nano` (^O, ^X)
- `htop` / `btop` (color, mouse click, F-keys)
- `top` (refresh, field toggle)
- `tmux` (split, resize, status, copy-mode, mouse, `allow-passthrough on`)
- **`vim` inside `tmux` — distinct entry**
- `ssh` localhost → all of the above
- `man` (less-based)
- `ranger` / `mc`

RFC §13.10 formalizes the golden-replay contract:

- PTY byte streams recorded per compat entry.
- Engine replay → recorded grid snapshot match.
- Cursor + mode state compared.

### 2.2 Why compat is the catch-all

RFC §22 lists twenty concrete failure modes. EPIC-A retires #5, #6, #7.
EPIC-B retires #8, #9, #10, #11. EPIC-C retires #16. EPIC-D retires #19,
#20. EPIC-E retires #1, #2, #3, #4, #12, #13, #14, #18. That leaves
#15 (ssh slow link latency), #17 (engine crash mid-alt-screen → black
screen — EPIC-H), and every "seam" regression that only shows up when a
real program exercises many subsystems at once. Compat is the only
layer that catches "program X broke under our engine" because only here
do we feed *real* bytes from a *real* program through the *real* stack.

### 2.3 Relation to EPIC-H

EPIC-H consumes G's compat matrix to power its side-by-side harness:
each golden stream also flows through xterm, and the cell diff must be
zero. If any compat entry has an outstanding `compat-gap/` report when
EPIC-H starts, EPIC-H cannot exit (§19 gate `xterm vs canvas diff = 0`
cannot be green). This is the hard sequencing reason G must ship clean
before H.

### 2.4 Relation to ADR 0014 (architecture invariants)

Compat fixtures live under the owning crate (`crates/quanta-vt/tests/`)
per ADR 0014. The scripted interactive runner lives in
`tests/integration/` because it crosses crate boundaries (session +
core + vt + proto).

## 3. Scope

### 3.1 Per-program fixture files

For each of the 14 compat programs below, the following five files
exist under `crates/quanta-vt/tests/compat/<program>/`:

1. `input.pty` — raw PTY bytes recorded via `script(1)` or equivalent.
2. `scenario.md` — human-readable description: what steps produced the
   byte stream, what the expected observable state is.
3. `expected_grid_snapshot.json` — canonical grid dump at end-of-feed.
4. `expected_cursor.json` — cursor row/col/shape/visibility.
5. `expected_modes.json` — `TerminalModeState` snapshot (DECCKM,
   bracketed paste, focus, mouse, modifyOtherKeys, kitty level,
   alt-screen active, SUM).

**Programs (14 total — 13 from RFC §13.9 + `vim-in-tmux` as distinct entry)**:

| # | Program | Fixture dir |
|---|---------|-------------|
| 1 | vim | `crates/quanta-vt/tests/compat/vim/` |
| 2 | nvim | `crates/quanta-vt/tests/compat/nvim/` |
| 3 | less | `crates/quanta-vt/tests/compat/less/` |
| 4 | nano | `crates/quanta-vt/tests/compat/nano/` |
| 5 | htop | `crates/quanta-vt/tests/compat/htop/` |
| 6 | btop | `crates/quanta-vt/tests/compat/btop/` |
| 7 | top | `crates/quanta-vt/tests/compat/top/` |
| 8 | man | `crates/quanta-vt/tests/compat/man/` |
| 9 | ranger | `crates/quanta-vt/tests/compat/ranger/` |
| 10 | mc | `crates/quanta-vt/tests/compat/mc/` |
| 11 | tmux | `crates/quanta-vt/tests/compat/tmux/` |
| 12 | vim-in-tmux | `crates/quanta-vt/tests/compat/vim-in-tmux/` |
| 13 | ssh-loopback | `crates/quanta-vt/tests/compat/ssh-loopback/` |
| 14 | ncmpcpp | `crates/quanta-vt/tests/compat/ncmpcpp/` |

Total fixture files: 14 × 5 = 70 committed artifacts.

### 3.2 Shared infra files (new)

- `crates/quanta-vt/tests/compat/harness.rs` — Rust harness that reads
  `input.pty`, constructs `Grid::new(24, 80, …)`, feeds bytes, dumps
  final state, compares against expected JSON. Generates
  `compat-gap/<program>_<timestamp>.report` on mismatch. See §4.2.
- `crates/quanta-vt/tests/compat/mod.rs` — module file exporting
  harness utilities and the per-program test functions.
- `crates/quanta-vt/tests/compat/VERSIONS.md` — per-program version
  tracking (program name, version string, capture date, capture host
  OS, locale, `TERM`, terminal-size).
- `crates/quanta-vt/tests/compat/README.md` — how to re-record, how to
  add a new program, how to read a gap report.
- `crates/quanta-vt/tests/compat_replay.rs` — top-level test module;
  one `#[test]` per program; calls into `harness.rs`.
- `scripts/record-compat-stream.sh` — `script(1)` wrapper with fixed
  `TERM=xterm-256color`, `LINES=24`, `COLUMNS=80`, clean `$HOME`
  tempdir, UTC timezone, locale `en_US.UTF-8`.
- `scripts/record-compat-stream.md` — operator instructions; referenced
  from `VERSIONS.md`.
- `tests/integration/tests/compat_scripted.rs` — scripted interactive
  runner. For each program, spawns under a PTY (via `portable-pty` or
  `nix::pty`), sends scripted keystrokes, polls grid state through the
  session actor, asserts expected transitions. See §4.3.
- `tests/integration/tests/compat_scripted/` (module directory) —
  per-program scripted scenario modules (`vim.rs`, `less.rs`,
  `htop.rs`, `tmux.rs`, `vim_in_tmux.rs`, `ssh.rs`, `nano.rs`,
  `ranger.rs`, `ncmpcpp.rs`, `nvim.rs`, `btop.rs`, `top.rs`, `man.rs`,
  `mc.rs`). 14 program modules.
- `compat-gap/README.md` — how to file, triage, resolve a compat gap.
- `compat-gap/TEMPLATE.md` — the gap report template.
- `compat-gap/.gitignore` — ignores generated `*.report` files produced
  by a failing test run; only README + TEMPLATE + resolved/ are tracked.
- `compat-gap/resolved/` — archive of fixed gaps (moved here on close).

### 3.3 Out of scope

- `vim-in-ssh` (layered — ssh loopback + vim inside it). SHOULD not
  MUST for v1; covered by EPIC-G follow-up if schedule allows.
- `emacs -nw` — RFC classifies as SHOULD (§14) not MUST; moved to
  §14-track compat harness, not §13.9 track.
- `neovim --embed` / `:term` nested PTY beyond one level — deferred.
- Windows-specific compat programs (PowerShell / WSL quirks) — tracked
  in EPIC-K's platform matrix document, not this epic.
- sixel / kitty graphics compat — RFC 0003 (deferred per §15).
- Bidirectional text compat — RFC §15 defers RTL entirely.

### 3.4 Assumptions

- Programs listed are available on the capture host at recording time
  (versions captured in `VERSIONS.md`).
- `sshd` is available locally for `ssh-loopback`; test skips with a
  clear log line if not.
- `tmux` is available with `allow-passthrough on` configurable.
- EPIC-B's `Grid::feed` is stable enough that a recorded stream
  produces deterministic output across runs (no Instant-keyed state,
  no thread-scheduling-dependent ordering).

## 4. Design

### 4.1 Golden-stream recording environment

The stream-recording environment is **fixed**. Any variance between
recording environment and replay environment is a bug in one of them.

- `TERM=xterm-256color`
- `LINES=24`, `COLUMNS=80`
- `HOME` = freshly-created tempdir, containing only what the scenario
  needs (e.g., for `vim`, a single file `hello.txt`).
- Timezone: UTC (`TZ=UTC`).
- Locale: `en_US.UTF-8` unless the scenario explicitly requires another
  (Korean / Japanese / Chinese scenarios use `ko_KR.UTF-8` / `ja_JP.UTF-8`
  / `zh_CN.UTF-8` respectively; locale is recorded in
  `scenario.md` and `VERSIONS.md`).
- No color-capability auto-detection; `COLORTERM=truecolor` always set
  (matches Phase 3 input-encoder expectations).
- `NO_COLOR` unset.
- `ECHO`, `ICANON`, `ISIG` default termios (we want programs to run as
  they would under a normal login).
- PATH restricted to `/usr/bin:/bin:/usr/local/bin` so that
  `alias`-generated output doesn't leak in.

`scripts/record-compat-stream.sh` scaffolds this. Operator invokes:

```
scripts/record-compat-stream.sh vim        \
  --version 9.0                            \
  --scenario scenarios/vim-basic.sh        \
  --out crates/quanta-vt/tests/compat/vim/
```

The script:

1. Creates a fresh tempdir, binds as `$HOME`.
2. Exports fixed environment (above).
3. Runs `script -q -c "<program> …" crates/quanta-vt/tests/compat/<program>/input.pty.raw`.
4. Post-processes the raw recording to strip `script(1)`'s framing
   (timestamps, header/footer line).
5. Dumps the final grid (via a `quanta-replay dump-grid` companion
   tool — see RFC §14.2 — landing via EPIC-J's debug-tool track) into
   `expected_grid_snapshot.json` / `expected_cursor.json` /
   `expected_modes.json`.
6. Appends a row to `VERSIONS.md` (program, version, date, host OS,
   locale, recorder name).

**Why `script(1)` and not our own PTY recorder**: `script(1)` is
ubiquitous, deterministic, well-understood; our PTY recorder would
introduce a dependency chain that changes over time. `script`'s output
is a raw byte stream, which is exactly what `Grid::feed` wants.

**Caveat — non-determinism**: some programs emit time-of-day (e.g.,
`top` header, `htop` clock). The recording scenario pins `TZ=UTC` and
for `top`/`htop` mocks the clock via `faketime` where available;
otherwise the scenario pins the first N bytes (no clock yet displayed)
and skips later clock-dependent lines in the expected snapshot (marked
as "redacted-clock" in `scenario.md`).

### 4.2 Harness algorithm (`harness.rs`)

```rust
// Pseudo-code; actual impl lands in EPIC-G implementation.
pub fn replay_and_compare(program: &str) -> Result<(), GapReport> {
    let fixture_dir = Path::new("crates/quanta-vt/tests/compat").join(program);
    let input = fs::read(fixture_dir.join("input.pty"))?;
    let expected_grid = load_grid_snapshot(fixture_dir.join("expected_grid_snapshot.json"))?;
    let expected_cursor = load_cursor(fixture_dir.join("expected_cursor.json"))?;
    let expected_modes = load_modes(fixture_dir.join("expected_modes.json"))?;

    let mut grid = Grid::new(24, 80, WidthClassifier::default(), /* sane defaults */);
    let events = grid.feed(&input);

    let actual_grid = grid.snapshot();
    let actual_cursor = grid.cursor().clone();
    let actual_modes = grid.mode_state().clone();

    let mut diffs = Vec::new();
    if let Some(d) = diff_grids(&expected_grid, &actual_grid) { diffs.push(d); }
    if let Some(d) = diff_cursor(&expected_cursor, &actual_cursor) { diffs.push(d); }
    if let Some(d) = diff_modes(&expected_modes, &actual_modes) { diffs.push(d); }

    if diffs.is_empty() {
        Ok(())
    } else {
        let report = GapReport {
            program: program.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            input_len: input.len(),
            event_count: events.len(),
            diffs,
            versions_md: fs::read_to_string(fixture_dir.join("../VERSIONS.md"))?,
        };
        report.write_to(Path::new("compat-gap"))?;
        Err(report)
    }
}
```

Key properties:

1. **Fresh engine every run.** No shared state between programs.
2. **Canonicalization before diff.** `GridSnapshot` is serialized via
   a stable format (sorted keys, fixed-width indent) before comparison.
   Two snapshots that differ only in JSON key ordering compare equal.
3. **Byte-for-byte after canonicalization.** No fuzzy matching. If the
   engine produced a different grid, the report contains the exact
   cells that differ.
4. **On mismatch, the test FAILS** (`panic!` via `assert!`). Each test
   is gated behind `#[test] fn compat_<program>()`; CI sees one failure
   per broken program.
5. **Report persistence.** Even on failure, the `compat-gap/*.report`
   is written. CI uploads it as a build artifact so the engineer sees
   the diff without re-running locally.

Canonicalization rules (to be pinned in `harness.rs` doc comments):

- `GridSnapshot.cells`: array-of-rows, each row array-of-cells, sorted
  by row then column. Cells with default attributes + empty grapheme
  are dropped to a single `null`.
- `expected_grid_snapshot.json` **always** has canonicalized form; the
  record script runs canonicalization before writing.
- Numeric fields use integers; no floats.
- Strings are UTF-8 with no escape-sequence passthrough.

### 4.3 Scripted interactive harness (`tests/integration/tests/compat_scripted.rs`)

The scripted harness exercises the full stack: real program → real PTY
→ `quanta-session::actor` → `quanta-vt::Grid` → event stream →
`GridMirror` (Rust-side test double, not TS UI) → assertions.

Outline:

```rust
#[test]
fn compat_vim_basic() {
    let mut runner = ScriptedRunner::new("vim-basic");
    runner.spawn("vim", &["/tmp/hello.txt"]);

    runner.expect_alt_screen_entered_within(Duration::from_millis(500));
    runner.send_keys("iHello, world!\x1b"); // insert "Hello, world!" then ESC
    runner.expect_grid_contains("Hello, world!", /* row */ 0, /* col */ 0);
    runner.send_keys(":wq\n");
    runner.expect_program_exited_within(Duration::from_secs(2));
    runner.expect_alt_screen_exited();
    runner.expect_cursor_at_home();

    let final_grid = runner.snapshot();
    // Compare with a per-scenario golden OR check observable assertions.
}
```

`ScriptedRunner` responsibilities:

- Spawn the program inside a PTY sized 24×80 with the fixed env from
  §4.1.
- Route stdout bytes through `quanta-session::actor`, which feeds
  `Grid::feed`; `actor` emits events over its fanout.
- Subscribe a test sink to the fanout; mirror events into an in-process
  `GridMirror`-like reducer.
- Provide polling assertions: `expect_grid_contains`,
  `expect_cursor_at`, `expect_mode_state(DECCKM, true)`,
  `expect_alt_screen_entered_within(Duration)`,
  `expect_program_exited_within(Duration)`, etc.
- Deliver scripted keystrokes via the encoder from EPIC-E (this is how
  we verify input *and* output in one test).
- On timeout or assertion failure, dump the last grid + event trace to
  `compat-gap/<program>_scripted_<timestamp>.report` (same schema as
  replay).

**Per-program scripted scenarios** are listed in §4.4; each is 5-15
discrete steps.

### 4.4 Per-program scenarios (specification)

For each MUST program, the scenario is authored once. Another engineer
can implement it from the spec alone (no clarifying questions needed).
Each scenario specifies: title, precondition, steps, expected
observable state per step or at end.

#### 4.4.1 `vim` — basic edit

- **Title**: `vim-basic-edit-save`.
- **Precondition**: tempdir with empty file `hello.txt`.
- **Steps**:
  1. Launch `vim /tmp/hello.txt`.
  2. Expect alt-screen entered within 500 ms; expect
     `ModeChanged(AltScreen, true)` emitted before first cell delta on
     alt buffer.
  3. Send `i`.
  4. Send `Hello, world!` (literal ASCII).
  5. Send `\x1b` (ESC to leave insert mode).
  6. Expect grid row 0 contains `Hello, world!` starting col 0.
  7. Send `:wq\n`.
  8. Expect alt-screen exited within 500 ms.
  9. Expect cursor at prompt row (row 23 col 0 on shell).
  10. Expect prior shell output still visible (main buffer preserved).
- **End state**: main-buffer grid shows the shell prompt; alt buffer no
  longer active; file `hello.txt` contains exactly `Hello, world!\n`.

#### 4.4.2 `less` — paged viewing

- **Title**: `less-page-search-quit`.
- **Precondition**: `/tmp/paged.txt` containing 200 lines numbered
  `line 1\nline 2\n...\nline 200\n`.
- **Steps**:
  1. Launch `less /tmp/paged.txt`.
  2. Expect alt-screen entered.
  3. Expect grid row 0 contains `line 1`; row 23 contains status line
     ending in `:`.
  4. Send `SPACE` (page down).
  5. Expect grid row 0 contains `line 24` or `line 25` depending on
     less version (pinned by `VERSIONS.md`).
  6. Send `/` then `50\n` (search for "50").
  7. Expect highlighted match; cursor on the line containing `line 50`.
  8. Send `n` (next match).
  9. Expect cursor on `line 150` (only "50" in `line 150`).
  10. Send `q`.
  11. Expect alt-screen exited.
  12. Expect scrollback on main buffer is UNCHANGED from pre-launch
      (less wrote nothing to main).
- **End state**: main buffer identical byte-for-byte to pre-launch.

#### 4.4.3 `htop` — system monitor

- **Title**: `htop-color-sort-quit`.
- **Precondition**: `htop` installed; a bunch of processes running.
- **Steps**:
  1. Launch `htop`.
  2. Expect alt-screen entered.
  3. Expect color output: at least one cell with non-default `fg` in
     the header row.
  4. Expect mouse-tracking enabled (`ModeChanged(Mouse, SGR1006)`
     or equivalent).
  5. Wait 1 refresh tick; expect a `GridDelta` with header row changes
     (clock).
  6. Send `F6` (sort menu).
  7. Expect overlay menu visible (right-hand pane overlay).
  8. Send `ESC` to dismiss.
  9. Send `F10` (quit).
  10. Expect alt-screen exited; main-buffer cursor at prompt.
- **Caveat**: clock refresh bytes are `redacted-clock` in the golden
  stream (see §4.1).

#### 4.4.4 `tmux` — pane management

- **Title**: `tmux-new-split-swap`.
- **Precondition**: no pre-existing tmux server; `~/.tmux.conf` empty.
- **Steps**:
  1. Launch `tmux new-session -s compat`.
  2. Expect alt-screen entered (tmux always runs on alt).
  3. Expect status line at row 23 (default tmux status position).
  4. Send `C-b %` (split vertically).
  5. Expect grid now shows two panes divided by a vertical bar at
     col 40.
  6. Send a unique string `PANE_TWO_HERE\n` to the active pane.
  7. Expect `PANE_TWO_HERE` visible in the right pane.
  8. Send `C-b o` (swap pane focus).
  9. Send `echo PANE_ONE\n`.
  10. Expect `PANE_ONE` visible in left pane; `PANE_TWO_HERE` still in
      right pane.
  11. Send `C-b d` (detach).
  12. Expect alt-screen exited; main-buffer cursor back at prompt;
      tmux server still running in background (verify with
      `tmux ls`).
  13. Kill tmux server (`tmux kill-server`) to clean up.
- **Caveat**: `allow-passthrough on` is NOT set by default; this
  scenario verifies that basic tmux works without passthrough. A
  separate passthrough-enabled scenario is out of scope (§3.3 defers
  it to a follow-up).

#### 4.4.5 `vim-in-tmux` — **distinct entry**

- **Title**: `vim-inside-tmux-edit-save-detach`.
- **Precondition**: `tmux` + `vim` installed; tempdir with `hello.txt`.
- **Steps**:
  1. Launch `tmux new-session -s compat-vim`.
  2. Expect alt-screen entered (tmux).
  3. Send `vim /tmp/hello.txt\n` to tmux pane.
  4. Expect **nested alt-screen**: tmux is already on alt; vim sets
     1049 inside tmux; depth counter = 2 (tracked by engine per EPIC-B
     §domain/modes).
  5. Expect `ModeChanged(AltScreen, Nested { depth: 2 })` or equivalent.
  6. Send `iNested hello!\x1b:wq\n`.
  7. Expect vim exits; tmux pane shows vim's exit output; nested depth
     back to 1.
  8. Send `C-b d` (detach tmux).
  9. Expect alt-screen exited; depth = 0.
  10. File `hello.txt` contains `Nested hello!\n`.
- **Why distinct**: tmux + vim is the canary RFC §5 lists as the
  single most important compat scenario. A `vim` golden under
  non-tmux doesn't exercise the nested-alt-screen code path at all.

#### 4.4.6 `ssh-loopback`

- **Title**: `ssh-loopback-vim`.
- **Precondition**:
  - `sshd` running on localhost (port 22 or custom port `2222`).
  - Passwordless SSH key installed for current user.
  - Test-skip guard: if `ssh localhost true` fails within 2 s, test
    is marked `ignored` with a `[SKIP] ssh unavailable on this host`
    log line (NOT a failure).
- **Steps**:
  1. Launch `ssh -o StrictHostKeyChecking=no localhost`.
  2. Expect remote shell prompt.
  3. Expect `TERM=xterm-256color` on remote side (verify via
     `echo $TERM\n`).
  4. Send `vim /tmp/remote-hello.txt\n`.
  5. Expect alt-screen entered (remote vim, encoded through local
     engine).
  6. Send `iRemote hello!\x1b:wq\n`.
  7. Expect vim exits.
  8. Send `exit\n` to close the ssh session.
  9. Expect main-buffer shell prompt restored.
- **Caveat**: keystroke latency over loopback is < 1 ms; this is not
  a stand-in for slow-link tests (RFC §22 #15 — covered separately
  under EPIC-J's perf harness with injected latency).

#### 4.4.7 `nano`

- **Title**: `nano-edit-save-exit`.
- **Precondition**: tempdir with empty `note.txt`.
- **Steps**:
  1. Launch `nano /tmp/note.txt`.
  2. Expect alt-screen entered; bottom two rows show nano menu.
  3. Send `hello nano`.
  4. Expect `hello nano` visible at row 0.
  5. Send `C-o` (WriteOut).
  6. Expect prompt at row 22 ("File Name to Write:").
  7. Send `\n` (accept default filename).
  8. Expect status message "Wrote 1 line".
  9. Send `C-x` (exit).
  10. Expect alt-screen exited.
- **End state**: `note.txt` contains `hello nano\n`.

#### 4.4.8 `ranger`

- **Title**: `ranger-navigate-open`.
- **Precondition**: tempdir with `a.txt`, `b.txt`, `c.txt`; `ranger`
  installed; `$VISUAL=nano` set for this test.
- **Steps**:
  1. Launch `ranger /tmp/`.
  2. Expect alt-screen entered; three-pane layout visible.
  3. Send `j j` (move down twice).
  4. Expect selection on `c.txt` (third file).
  5. Send `\n` (open with `$VISUAL`).
  6. Expect nano now active; `c.txt` visible.
  7. Send `C-x` (exit nano).
  8. Expect back to ranger.
  9. Send `q` (quit ranger).
  10. Expect alt-screen exited.

#### 4.4.9 `ncmpcpp`

- **Title**: `ncmpcpp-launch-quit`.
- **Precondition**: `ncmpcpp` installed; `mpd` NOT required to be
  running (ncmpcpp shows "connecting" but runs).
- **Steps**:
  1. Launch `ncmpcpp`.
  2. Expect alt-screen entered.
  3. Expect status bar at row 23.
  4. Send `q` (quit).
  5. Expect alt-screen exited.
- **Caveat**: ncmpcpp is shipped as a MUST entry per original compat
  list because it's a popular curses-UI program; its scenarios are
  intentionally minimal (launch + quit) because deeper testing
  requires `mpd` which is out of scope for a self-contained fixture.
  More scenarios are EPIC-G follow-up if schedule allows.

#### 4.4.10 `nvim`

- **Title**: `nvim-basic-edit-save`.
- **Precondition**: tempdir with `hello.txt`.
- **Steps**: Same as §4.4.1 (`vim`) but with `nvim`. Kept distinct
  because neovim's alt-screen enter sequence and SGR handling differ
  in detail (e.g., nvim uses `tui-v3` mode detection; vim uses
  `t_Co=256` heuristic). Golden streams will differ byte-for-byte.

#### 4.4.11 `btop`

- **Title**: `btop-color-quit`.
- **Precondition**: `btop` installed.
- **Steps**:
  1. Launch `btop`.
  2. Expect alt-screen entered; truecolor output at header.
  3. Expect at least one cell with truecolor fg (`Color::TrueColor`).
  4. Wait 1 refresh tick.
  5. Send `q`.
  6. Expect alt-screen exited.

#### 4.4.12 `top`

- **Title**: `top-refresh-quit`.
- **Precondition**: `top` installed.
- **Steps**:
  1. Launch `top -b -n 0` for recording (batch mode falls back to
     non-alt-screen); for scripted, use `top` interactive.
  2. Expect alt-screen entered.
  3. Wait 1 refresh tick (default 3s; override with `-d 1`).
  4. Send `q`.
  5. Expect alt-screen exited.

#### 4.4.13 `man`

- **Title**: `man-less-view-quit`.
- **Precondition**: `man` + `less` installed; `man ls` available.
- **Steps**:
  1. Launch `man ls`.
  2. Expect alt-screen entered (man invokes less).
  3. Expect grid row 0 contains `LS(1)`.
  4. Send `q`.
  5. Expect alt-screen exited.

#### 4.4.14 `mc` (Midnight Commander)

- **Title**: `mc-navigate-quit`.
- **Precondition**: `mc` installed; tempdir with a few files.
- **Steps**:
  1. Launch `mc /tmp/ /tmp/`.
  2. Expect alt-screen entered; dual-panel layout.
  3. Send `F10` (quit).
  4. Expect confirmation dialog.
  5. Send `\n` (confirm).
  6. Expect alt-screen exited.

### 4.5 `compat-gap/<program>_<timestamp>.report` schema

Generated on any mismatch. Versioned JSON (schema_version = 1).

```json
{
  "schema_version": 1,
  "program": "vim",
  "scenario": "vim-basic-edit-save",
  "timestamp_utc": "2026-05-12T14:23:11Z",
  "harness": "replay|scripted",
  "engine_commit_sha": "abc1234...",
  "fixture": {
    "input_len_bytes": 14528,
    "event_count": 312
  },
  "expected": { "grid": "...", "cursor": "...", "modes": "..." },
  "actual":   { "grid": "...", "cursor": "...", "modes": "..." },
  "diffs": [
    {
      "kind": "cell",
      "row": 5,
      "col": 14,
      "expected": { "grapheme": "한", "width": 2, "fg": "Default" },
      "actual":   { "grapheme": "한", "width": 1, "fg": "Default" }
    },
    {
      "kind": "cursor",
      "expected": { "row": 5, "col": 16 },
      "actual":   { "row": 5, "col": 15 }
    },
    {
      "kind": "mode",
      "mode": "AltScreen",
      "expected": true,
      "actual": false
    }
  ],
  "versions_md_excerpt": "vim 9.0.1234, macOS 14.5, en_US.UTF-8, 2026-04-22"
}
```

Operator workflow (documented in `compat-gap/README.md`):

1. Read the report's `diffs` array.
2. If the divergence is in engine behavior → file a bug against
   `quanta-vt`; reference the report filename.
3. If the divergence is expected (e.g., legitimate program update
   between recordings) → re-record, bump `VERSIONS.md`, move report
   to `compat-gap/resolved/<program>_<timestamp>_resolved.md` with
   a resolution note.
4. `compat-gap/` must be clean (only README + TEMPLATE + `resolved/`)
   before EPIC-H kickoff. CI job `compat-gap-empty-check` enforces.

### 4.6 Fuzz + resize stress alongside compat

Per RFC §14.3 + §14.4. Implemented here because compat is the exit
gate that consumes them.

- `crates/quanta-vt/fuzz/fuzz_targets/vte_process.rs` (already landed
  in EPIC-B) runs 2 hours nightly via EPIC-K CI. After fuzz run,
  compat replay suite re-runs; any regression in compat after fuzz
  run is treated as a fuzz-discovered defect.
- Resize stress (RFC §14.4): within each scripted scenario,
  `ScriptedRunner` optionally cycles resize 200 times (40 → 120 cols,
  10 → 60 rows, back) during program runtime; the program must not
  crash and the post-resize grid must remain consistent with the
  engine's reflow semantics (continuation-flag invariants from
  EPIC-B §domain/grid).

### 4.7 `VERSIONS.md` layout

Single markdown table, one row per (program × capture), kept in the
compat directory so that provenance travels with the fixture.

```
| Program | Version | Host OS | Locale | Date | Recorder | Notes |
|---------|---------|---------|--------|------|----------|-------|
| vim | 9.0.1234 | macOS 14.5 (arm64) | en_US.UTF-8 | 2026-04-22 | @alex | baseline |
| vim | 9.0.1234 | Ubuntu 22.04 (x86_64) | en_US.UTF-8 | 2026-04-22 | @alex | cross-platform corroboration |
| ssh-loopback | OpenSSH_9.0 | macOS 14.5 | en_US.UTF-8 | 2026-04-23 | @alex | sshd=built-in |
| tmux | 3.3a | macOS 14.5 | en_US.UTF-8 | 2026-04-23 | @alex | allow-passthrough=off |
| vim-in-tmux | vim 9.0.1234, tmux 3.3a | macOS 14.5 | en_US.UTF-8 | 2026-04-23 | @alex | nested-alt-screen test |
| ... | | | | | | |
```

Every row must include version AND capture date; `scripts/record-compat-stream.sh`
appends automatically.

## 5. Definition of Done (≥ 40 items)

Items grouped by surface. Every item is testable and gated in CI or a
documented dogfood.

### 5.1 Per-program fixture coverage (14 × 5 = 70 files baseline + per-item checks)

- [ ] `vim/input.pty` committed; non-zero size; parses as valid UTF-8-or-binary bytes.
- [ ] `vim/scenario.md` committed; matches §4.4.1 structure.
- [ ] `vim/expected_grid_snapshot.json` committed; canonical form.
- [ ] `vim/expected_cursor.json` committed.
- [ ] `vim/expected_modes.json` committed.
- [ ] `nvim/` — all 5 files, same shape as vim/.
- [ ] `less/` — all 5 files.
- [ ] `nano/` — all 5 files.
- [ ] `htop/` — all 5 files; clock bytes documented as redacted in scenario.md.
- [ ] `btop/` — all 5 files.
- [ ] `top/` — all 5 files; refresh-tick bytes redacted.
- [ ] `man/` — all 5 files (`man ls`).
- [ ] `ranger/` — all 5 files.
- [ ] `mc/` — all 5 files.
- [ ] `tmux/` — all 5 files; `allow-passthrough off` documented.
- [ ] `vim-in-tmux/` — all 5 files; **explicitly distinct from vim/**.
- [ ] `ssh-loopback/` — all 5 files; falls back to `[SKIP]` on hosts without sshd.
- [ ] `ncmpcpp/` — all 5 files.

### 5.2 Harness correctness

- [ ] `harness.rs` replays every committed `input.pty` and either
      matches or produces a gap report.
- [ ] `harness.rs` canonicalizes JSON before compare (order-independent).
- [ ] `harness.rs` writes `compat-gap/<program>_<ts>.report` on mismatch
      with schema version 1 (§4.5).
- [ ] `harness.rs` failures include `engine_commit_sha` in the report.
- [ ] `cargo test -p quanta-vt --test compat_replay` green on all 14
      programs against the committed fixtures.
- [ ] Harness runs in < 2 min per program on CI.

### 5.3 Scripted interactive harness

- [ ] `ScriptedRunner` spawns real programs in a PTY sized 24×80.
- [ ] `ScriptedRunner` asserts `ModeChanged(AltScreen, true)` arrives
      BEFORE first alt-buffer cell delta for every alt-screen program
      (RFC §9.2 ordering invariant).
- [ ] `ScriptedRunner` exposes `expect_grid_contains`, `expect_cursor_at`,
      `expect_mode_state`, `expect_alt_screen_entered_within`,
      `expect_program_exited_within`.
- [ ] All 14 program scenarios run green under `cargo test --test
      compat_scripted`.
- [ ] `vim-in-tmux` verifies **nested alt-screen depth = 2**.
- [ ] `ssh-loopback` gracefully skips with `[SKIP]` log when sshd
      unavailable; no false failure.

### 5.4 `compat-gap/` workflow

- [ ] `compat-gap/README.md` committed; explains triage workflow.
- [ ] `compat-gap/TEMPLATE.md` committed; matches schema §4.5.
- [ ] `compat-gap/.gitignore` ignores generated `*.report` (only
      README, TEMPLATE, and `resolved/` are tracked).
- [ ] `compat-gap/resolved/` directory exists (may be empty at merge).
- [ ] CI job `compat-gap-empty-check` fails if any unresolved
      `*.report` exists at the EPIC-H kickoff commit.

### 5.5 Fuzz + resize stress integration

- [ ] 2-hour nightly fuzz run configured in CI (EPIC-K owns schedule;
      target owned here).
- [ ] Fuzz run followed by compat replay re-run; divergence = blocker.
- [ ] Resize stress: `ScriptedRunner` supports 200-cycle resize option;
      enabled in 3+ scripted scenarios (`vim`, `tmux`, `htop`).

### 5.6 Recording tooling

- [ ] `scripts/record-compat-stream.sh` exists, executable, documented.
- [ ] Script exports fixed env per §4.1.
- [ ] Script post-processes `script(1)` raw output to strip framing.
- [ ] Script appends a row to `VERSIONS.md` automatically.
- [ ] `VERSIONS.md` has a row per (program × capture); every fixture
      has at least one row.

### 5.7 Dogfood

- [ ] 90-minute interactive dogfood log per program (14 × 90 min =
      ~21 hours of dogfooding total, split across the team).
- [ ] Dogfood log is archived under `docs/dogfood/epic-g/<program>.md`
      with observations, any rendering anomaly, and resolution.
- [ ] Dogfood sign-off checkbox ticked by at least 2 team members.

### 5.8 Housekeeping / policy

- [ ] No fixture references a path outside `/tmp/` or the fixture's
      own tempdir (cleanroom principle).
- [ ] No fixture embeds real user paths, usernames, or secrets.
- [ ] `VERSIONS.md` has per-capture 1-line description (date + version
      + recorder).
- [ ] `cargo clippy -p quanta-vt -- -D warnings` clean after harness
      lands.
- [ ] Harness imports only `quanta-vt` + `serde_json` + `chrono`; no
      I/O crates besides `std::fs`.

**Total DoD items**: 52 (18 + 6 + 6 + 5 + 3 + 5 + 3 + 6).

## 6. Quality Gates

| Gate | Check | Owner | Failure action |
|------|-------|-------|----------------|
| **Golden-replay parity** | `cargo test -p quanta-vt --test compat_replay` green on all 14 programs | harness.rs | Engine bug or fixture-staleness triage |
| **Scripted-scenario pass** | `cargo test --test compat_scripted` green on all 14 programs | ScriptedRunner | Treat like any failing integration test |
| **`compat-gap/` empty** | CI job `compat-gap-empty-check` passes | CI | EPIC-H cannot start |
| **Fuzz + compat re-run** | Nightly fuzz + compat replay green for 7 consecutive nights before EPIC-H kickoff | CI + owner | Any regression blocks EPIC-H |
| **Dogfood sign-off** | 90-min log per program + 2-person sign-off | team | Missing sign-off blocks §19 gate line "1-week dogfood clean" |
| **Versioning provenance** | Every fixture has a `VERSIONS.md` row with date + version + recorder | CI shell script | Merge blocked on missing row |
| **Resize-stress cohabitation** | 200-cycle resize runs green in 3+ scripted scenarios | ScriptedRunner | Engine reflow bug |

## 7. E2E scenarios (per-program, executable)

Each scenario lists 5-15 steps; engineer can implement from this list
alone.

### 7.1 E2E-G-vim

1. Launch `vim /tmp/hello.txt`.
2. Assert alt-screen entered within 500 ms.
3. Assert `ModeChanged(AltScreen, true)` precedes first cell delta.
4. Send `i`.
5. Send `Hello, world!`.
6. Send `\x1b`.
7. Assert grid row 0 cols 0-12 == `Hello, world!`.
8. Send `:wq\n`.
9. Assert alt-screen exited within 500 ms.
10. Assert file `/tmp/hello.txt` == `Hello, world!\n`.

### 7.2 E2E-G-less

1. Precondition: `/tmp/paged.txt` has 200 numbered lines.
2. Launch `less /tmp/paged.txt`.
3. Assert alt-screen entered.
4. Assert grid row 0 contains `line 1`.
5. Send `SPACE`.
6. Assert grid row 0 contains `line 24` or `line 25`.
7. Send `/` then `50\n`.
8. Assert cursor on line containing `line 50`.
9. Send `n`.
10. Assert cursor on line containing `line 150` (next match of "50").
11. Send `g`.
12. Assert grid row 0 contains `line 1`.
13. Send `G`.
14. Assert grid shows tail of file (`line 200` visible).
15. Send `q`.
16. Assert alt-screen exited; main buffer unchanged.

### 7.3 E2E-G-htop

1. Launch `htop`.
2. Assert alt-screen entered.
3. Assert at least one cell has truecolor fg.
4. Assert mouse tracking enabled (`TerminalModeState.mouse != Off`).
5. Wait 1 refresh tick.
6. Send `F6`.
7. Assert sort-menu overlay visible (menu text in right pane).
8. Send `\x1b` (ESC).
9. Assert overlay dismissed.
10. Send `F10`.
11. Assert program exited; alt-screen exited.

### 7.4 E2E-G-tmux

1. Launch `tmux new-session -s e2e`.
2. Assert alt-screen entered.
3. Assert status line at row 23.
4. Send `\x02%` (Ctrl-b %, split vertically).
5. Assert vertical split bar present at col 40.
6. Send `PANE_TWO_HERE\n`.
7. Assert `PANE_TWO_HERE` visible in right pane.
8. Send `\x02o` (swap panes).
9. Send `echo PANE_ONE\n`.
10. Assert both `PANE_ONE` (left) and `PANE_TWO_HERE` (right) visible.
11. Send `\x02d` (detach).
12. Assert alt-screen exited.
13. Run `tmux kill-server` to clean up.

### 7.5 E2E-G-vim-in-tmux

1. Launch `tmux new-session -s e2e-vim`.
2. Assert alt-screen entered; depth = 1.
3. Send `vim /tmp/nested.txt\n`.
4. Assert `ModeChanged(AltScreen, true)` nested; depth = 2.
5. Send `iNested hello!\x1b`.
6. Assert grid row 0 contains `Nested hello!`.
7. Send `:wq\n`.
8. Assert vim exited; alt-screen depth = 1.
9. Send `\x02d` (tmux detach).
10. Assert alt-screen exited; depth = 0.
11. Assert file `/tmp/nested.txt` == `Nested hello!\n`.
12. Run `tmux kill-server`.

### 7.6 E2E-G-ssh

1. Precondition: `ssh localhost true` succeeds within 2 s. Otherwise skip.
2. Launch `ssh -o StrictHostKeyChecking=no localhost`.
3. Assert remote shell prompt.
4. Send `echo $TERM\n`.
5. Assert grid contains `xterm-256color`.
6. Send `vim /tmp/remote.txt\n`.
7. Assert alt-screen entered (remote program, local engine).
8. Send `iRemote hello!\x1b:wq\n`.
9. Assert vim exited.
10. Send `exit\n`.
11. Assert main-buffer local prompt restored.

### 7.7 E2E-G-nano

1. Launch `nano /tmp/note.txt`.
2. Assert alt-screen entered.
3. Assert bottom two rows show nano menu.
4. Send `hello nano`.
5. Assert grid row 0 contains `hello nano`.
6. Send `\x0f` (Ctrl-O).
7. Assert status prompt at row 22 ("File Name to Write:").
8. Send `\n`.
9. Assert status message `[ Wrote 1 line ]`.
10. Send `\x18` (Ctrl-X).
11. Assert alt-screen exited.
12. Assert `/tmp/note.txt` == `hello nano\n`.

### 7.8 E2E-G-ranger

1. Precondition: `/tmp/rg/a.txt`, `/tmp/rg/b.txt`, `/tmp/rg/c.txt`
   exist; `VISUAL=nano` env.
2. Launch `ranger /tmp/rg/`.
3. Assert alt-screen entered; three-pane layout.
4. Send `jj`.
5. Assert selection on `c.txt`.
6. Send `\n`.
7. Assert nano active (menu visible at bottom).
8. Send `\x18` (exit nano).
9. Assert ranger restored.
10. Send `q`.
11. Assert alt-screen exited.

### 7.9 E2E-G-ncmpcpp

1. Launch `ncmpcpp`.
2. Assert alt-screen entered.
3. Assert status bar at row 23.
4. Send `q`.
5. Assert alt-screen exited.

### 7.10 E2E-G-nvim

Same as E2E-G-vim but launching `nvim`. Golden bytes differ; observable
end-state identical (file contents + cursor position).

### 7.11 E2E-G-btop / E2E-G-top / E2E-G-man / E2E-G-mc

Minimal (launch → observe alt-screen → minimal interaction → quit)
per §4.4.11-14 scripts.

Each of the eleven E2Es above is codified as a `#[test] fn
e2e_g_<slug>()` under `tests/integration/tests/compat_scripted.rs`.

## 8. Test deliverables

| Deliverable | Count |
|-------------|-------|
| Fixture directories | 14 |
| Per-directory files | 5 (= 70 total) |
| Rust test functions (replay) | 14 |
| Rust test functions (scripted) | 14 |
| E2E scenario documents | 11 (4 programs consolidated in §7.11) |
| Harness crate-level files | 4 (harness.rs, mod.rs, VERSIONS.md, README.md) |
| Recording script files | 2 (record-compat-stream.sh, record-compat-stream.md) |
| `compat-gap/` files | 4 (README, TEMPLATE, .gitignore, resolved/.gitkeep) |
| 90-min dogfood logs | 14 |
| **Total committed artifacts** | **~135** |

## 9. Failure modes retired

Explicit mapping to RFC §22:

- **§22 #15** `ssh` slow link > 100 ms keystroke — scripted `ssh-loopback`
  baseline; slow-link variant covered by EPIC-J perf harness with
  injected latency; compat provides the correctness baseline.
- **Any seam regression** — compat catches anything that B/C/D/E/F unit
  tests miss because it replays real-program bytes.
- **Nested alt-screen correctness** — §22 #8 boundary case is caught by
  `vim-in-tmux` scenario (depth counter).
- **Resize under real load** — §22 #10 SIGWINCH delivery is verified
  via 200-cycle resize stress within scripted scenarios.
- **CJK / emoji under real shell output** — scenarios pull from RFC §21
  corpus (Korean/Japanese/Chinese strings) in `vim` and `less`
  scenarios; selection / copy correctness (§22 #6, §22 #20) indirectly
  exercised.

Remaining §22 items NOT retired here (tracked elsewhere):

- §22 #17 (engine crash black screen) → EPIC-H (degraded mode).
- §22 #19 (web font late load) → EPIC-D (renderer) — pixel-level,
  outside compat scope.

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Programs vary across distros/versions | High | Medium | `VERSIONS.md` pins version + date; goldens treated as per-version artifacts; multi-OS corroboration encouraged |
| tmux passthrough absent → some tmux escapes misread | Medium | Low | Scenario documents `allow-passthrough off`; passthrough-enabled scenario deferred |
| `sshd` unavailable on CI runner | High on Linux; Low on macOS | Low | Test skips cleanly with `[SKIP]` log; CI continues; EPIC-K re-enables on runners with sshd |
| `script(1)` semantic differs on macOS vs Linux | Medium | Medium | `record-compat-stream.sh` detects OS and calls `script -q -c "…" FILE` (Linux) or `script -q FILE "…"` (macOS); post-processing normalizes |
| Clock-dependent redaction misses a frame | Low | Low | `scenario.md` documents redacted rows; harness diff tolerates those rows only if explicitly listed; CI fails if a new clock-row appears unexpectedly |
| Nested alt-screen depth counter off-by-one | Low | High | `vim-in-tmux` scenario explicitly asserts depth = 2 mid-run and depth = 0 post-detach; EPIC-B §domain/modes owns the counter |
| Program version drift causes goldens to rot | High over time | Medium | Fuzz + compat nightly re-run; version drift triggers re-record workflow; `compat-gap/resolved/` archive provides institutional memory |
| CI runner lacks a compat program (e.g., `ncmpcpp` on minimal Linux images) | Medium | Low | Runners provisioned with full program set (EPIC-K owns image build); `cargo test` auto-skips programs whose binary is missing with `[SKIP] binary not found` |
| Recording takes hours per program | Low | Low | Scenarios are ≤ 30 s per program; full corpus recording ~10 min per host |
| Two recordings differ byte-for-byte due to PID / timestamp variance | Medium | Low | `scripts/record-compat-stream.sh` masks PID placeholders (`<PID>`) in scenario.md; harness compares against canonicalized snapshot not raw recording |

## 11. Rollback

Compat isn't a feature — it's a quality gate. There is no code to
revert if compat fails; instead:

- Failing MUST entries move to "known partial" state in RFC §19 gate.
- §19 gate line "golden replay 100% pass" stays FALSE.
- EPIC-I (xterm removal) does NOT start.
- Canvas renderer remains behind `experimental.renderer = 'canvas'`
  flag (per RFC §20 rollback clause).
- The specific failing scenario is documented in
  `compat-gap/resolved/<program>_<date>_deferred.md` with rationale
  ("awaiting engine fix X"), scheduled for a follow-up sprint.

## 12. Cross-references

- **RFC 0001 §13.9** — compat matrix MUST set.
- **RFC 0001 §13.10** — golden-replay contract (engine replay → grid match).
- **RFC 0001 §14.3** — fuzz testing.
- **RFC 0001 §14.4** — resize stress.
- **RFC 0001 §18** — testing strategy (golden PTY streams, cross-renderer, perf).
- **RFC 0001 §19** — final xterm-removal gate (lines: "Golden replay 100% pass", "vim OK", "tmux OK", "vim inside tmux OK", "ssh remote OK", "Alt-screen enter/exit/nested OK", "≥ 1 week dogfood clean" — G owns 6 of the 13 gate lines).
- **RFC 0001 §22** — 20 failure modes; G is catch-all for anything not retired upstream.
- **ADR 0014** — architecture invariants (crate-owned tests live under `crates/<name>/tests/`).
- **ADR 0017** — event envelope + ordering; compat verifies ordering invariants in real workloads.
- **EPIC-B** — `Grid::feed`, `GridSnapshot`, `TerminalModeState` — consumed by harness.
- **EPIC-C** — wire protocol; scripted harness exercises it end-to-end.
- **EPIC-D** — renderer backend contract; side-by-side (EPIC-H) consumes these fixtures.
- **EPIC-E** — input encoder; scripted runner uses it to deliver keystrokes.
- **EPIC-F** — session actor wiring; scripted runner depends on it.
- **EPIC-H** — consumes G's matrix for side-by-side diff.
- **EPIC-J** — telemetry; fuzz counters, perf harness budget; G consumes counters to verify no unknown-CSI storm during compat runs.
- **EPIC-K** — CI schedules the nightly fuzz + compat job; provisions compat-program binaries on runners.

## 13. Work breakdown

### Week 1 (5 working days)

- **Day 1-2** — `harness.rs` + `scripts/record-compat-stream.sh`.
  Record 1st-fixture smoke-test for `cat` (non-MUST, just proves the
  pipeline). Land `compat-gap/` scaffold + README + TEMPLATE.
- **Day 3-4** — Record `vim`, `less`, `nano`, `htop` goldens. Implement
  per-program `scenario.md` + expected JSON. Land replay tests for
  those four programs. CI green.
- **Day 5** — Record `tmux`, `vim-in-tmux`, `top`, `man` goldens.
  Implement replay tests. **Nested-alt-screen assertion** verified for
  `vim-in-tmux`.

### Week 1.5 (3 working days)

- **Day 6-7** — Record `ssh-loopback`, `ranger`, `mc`, `btop`,
  `ncmpcpp`, `nvim` goldens. Implement replay tests. Implement
  `[SKIP]` logic for `ssh-loopback` on hosts without sshd.
- **Day 8** — Implement `ScriptedRunner` in
  `tests/integration/tests/compat_scripted.rs`. Port the 14 scenario
  scripts. Land resize-stress cohabitation hook. 90-min dogfood runs
  per program; collect logs.

### Post-week housekeeping

- Archive 14 dogfood logs under `docs/dogfood/epic-g/`.
- Verify `compat-gap/` clean.
- Merge block-off: EPIC-H kickoff gated on `compat-gap-empty-check` CI
  job green + 2-person dogfood sign-off.

---

## Appendix A — Harness-to-fixture wiring contract

The harness reads fixtures via a small resolver:

```
fn fixture_dir(program: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/compat")
        .join(program)
}
```

This pins the directory layout. Moving fixtures or renaming programs
requires a grep of all call sites. Fixture paths are NEVER constructed
by string concatenation elsewhere; always through `fixture_dir()`.

## Appendix B — `compat-gap/` lifecycle

```
 (engineer runs compat suite locally)
           │
           ▼
 [fail] ──▶ harness writes compat-gap/<program>_<ts>.report
           │
           ▼
  Triage: engine bug? fixture stale? recording env drift?
           │
      ┌────┼─────────┐
      ▼    ▼         ▼
   engine  re-record  defer
    bug    fixture    with rationale
      │       │         │
      ▼       ▼         ▼
 fix lands  VERSIONS.md  resolved/<program>_<ts>_deferred.md
     │       row bumped      │
     ▼       │                │
  report     ▼                ▼
  moves to  report moves to  RFC §19 line stays FALSE
  resolved/ resolved/         (removal blocked)
```

Unresolved `*.report` files in `compat-gap/` (not in `resolved/`) MUST
block EPIC-H.

## Appendix C — Pre-recording checklist (operator)

Before running `scripts/record-compat-stream.sh`:

- [ ] Host has the target program installed at the version pinned by
      `VERSIONS.md` (or is establishing a new version baseline).
- [ ] Host's `script(1)` binary is BSD-style (macOS) or util-linux
      (Linux); script auto-detects.
- [ ] `faketime` is available if the scenario involves clock-dependent
      output (`top`, `htop`).
- [ ] Tempdir is newly created; no leftover state from previous run.
- [ ] No background activity on host that could emit to the recording
      PTY (check `ps -o tty=` for the controlling TTY).
- [ ] Terminal window sized to exactly 24×80 (if recording is happening
      in an actual terminal — CI records headlessly via `script`).

## Appendix D — "HOW the golden was captured" 1-line descriptions

Every fixture's `scenario.md` ends with a one-line capture provenance:

```
**Captured**: vim 9.0.1234 / macOS 14.5 (arm64) / en_US.UTF-8 / 2026-04-22 / by @alex
```

This is also mirrored in `VERSIONS.md`. Two sources of truth because
the fixture directory may be inspected in isolation (without scrolling
up to `VERSIONS.md`) and `VERSIONS.md` may be inspected without
opening each fixture.

---

**End of EPIC-G plan.**
