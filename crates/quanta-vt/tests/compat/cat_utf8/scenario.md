# Scenario: `cat_utf8`

- **Title**: `cat_utf8-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `sh` -c printf 'ascii line\n한글 test\n日本語\n'
- Version captured: `GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24)`

## Keystrokes

Sent to the PTY master in order, with `50ms` between each:



## Scenario

UTF-8 multi-byte line feed — ASCII, Korean (한글), Japanese (日本語). Exercises grapheme width classification on a real-program byte stream.

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
