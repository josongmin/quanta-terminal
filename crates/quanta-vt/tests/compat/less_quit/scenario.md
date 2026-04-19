# Scenario: `less_quit`

- **Title**: `less_quit-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `sh` -c printf 'line a\nline b\nline c\n' | less
- Version captured: `GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24)`

## Keystrokes

Sent to the PTY master in order, with `300ms` between each:

 1. `q`

## Scenario

`less` opens a 3-line corpus, draws its pager (alt-screen), then receives `q` and exits. Exercises DECSET 1049 enter → content → exit.

## Expected observable state

The end-of-feed `GridSnapshot`, `CursorPayload`, and `TerminalModeState`
are serialised into the sibling `expected_*.json` files by running
`bytes` through a fresh `Grid::new(24, 80, 10_000, classifier())` and
snapshotting. The replay harness (`compat_harness.rs`) auto-discovers
this directory and diffs cell-by-cell.

## Purpose

Proves the engine handles the byte stream emitted by a real `sh`
build — not just hand-written escape sequences. Regressions here surface
as compat-gap reports.

## Captured

**Captured**: sh / GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24) / macOS (Darwin arm64) / en_US.UTF-8 / 2026-04-19 / programmatic recorder
