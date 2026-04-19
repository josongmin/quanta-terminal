# Scenario: `man_ls`

- **Title**: `man_ls-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `man` ls
- Version captured: `/usr/bin/man: illegal option -- -`

## Keystrokes

Sent to the PTY master in order, with `300ms` between each:

 1. `q`

## Scenario

`man ls` opens the `ls(1)` manpage in the configured pager (less on macOS). `q` exits. Exercises bold + underline SGR on real prose.

## Expected observable state

The end-of-feed `GridSnapshot`, `CursorPayload`, and `TerminalModeState`
are serialised into the sibling `expected_*.json` files by running
`bytes` through a fresh `Grid::new(24, 80, 10_000, classifier())` and
snapshotting. The replay harness (`compat_harness.rs`) auto-discovers
this directory and diffs cell-by-cell.

## Purpose

Proves the engine handles the byte stream emitted by a real `man`
build — not just hand-written escape sequences. Regressions here surface
as compat-gap reports.

## Captured

**Captured**: man / /usr/bin/man: illegal option -- - / macOS (Darwin arm64) / en_US.UTF-8 / 2026-04-19 / programmatic recorder
