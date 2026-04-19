# Scenario: `nano_exit`

- **Title**: `nano_exit-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `nano` --restricted /tmp/quanta-compat-nano.txt
- Version captured: `TERM environment variable not set.`

## Keystrokes

Sent to the PTY master in order, with `500ms` between each:

 1. `\x18`

## Scenario

`nano --restricted` opens an empty file, paints its menu + status bars (alt-screen), receives Ctrl-X with no changes pending, exits cleanly.

## Expected observable state

The end-of-feed `GridSnapshot`, `CursorPayload`, and `TerminalModeState`
are serialised into the sibling `expected_*.json` files by running
`bytes` through a fresh `Grid::new(24, 80, 10_000, classifier())` and
snapshotting. The replay harness (`compat_harness.rs`) auto-discovers
this directory and diffs cell-by-cell.

## Purpose

Proves the engine handles the byte stream emitted by a real `nano`
build — not just hand-written escape sequences. Regressions here surface
as compat-gap reports.

## Captured

**Captured**: nano / TERM environment variable not set. / macOS (Darwin arm64) / en_US.UTF-8 / 2026-04-19 / programmatic recorder
