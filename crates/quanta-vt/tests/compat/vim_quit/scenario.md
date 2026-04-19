# Scenario: `vim_quit`

- **Title**: `vim_quit-programmatic-recording`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from real program via `portable_pty` scripted driver
- **Recorder**: `crates/quanta-vt/tests/fixtures_programmatic/record.rs`

## Precondition

Fresh 24×80 PTY. Fixed environment (`TERM=xterm-256color`, `LINES=24`,
`COLUMNS=80`, `TZ=UTC`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## Program

- Command: `vim` -u NONE -N -c q!
- Version captured: `VIM - Vi IMproved 9.1 (2024 Jan 02, compiled Jul 11 2025 21:28:27)`

## Keystrokes

Sent to the PTY master in order, with `100ms` between each:



## Scenario

`vim -u NONE -N -c 'q!'` — loads with no user config, queues an immediate force-quit. Exercises vim's alt-screen enter sequence even though the session is effectively zero-length.

## Expected observable state

The end-of-feed `GridSnapshot`, `CursorPayload`, and `TerminalModeState`
are serialised into the sibling `expected_*.json` files by running
`bytes` through a fresh `Grid::new(24, 80, 10_000, classifier())` and
snapshotting. The replay harness (`compat_harness.rs`) auto-discovers
this directory and diffs cell-by-cell.

## Purpose

Proves the engine handles the byte stream emitted by a real `vim`
build — not just hand-written escape sequences. Regressions here surface
as compat-gap reports.

## Captured

**Captured**: vim / VIM - Vi IMproved 9.1 (2024 Jan 02, compiled Jul 11 2025 21:28:27) / macOS (Darwin arm64) / en_US.UTF-8 / 2026-04-19 / programmatic recorder
