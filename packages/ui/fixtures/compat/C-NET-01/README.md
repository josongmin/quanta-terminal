# C-NET-01: ssh localhost echo hi

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-T). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

1. **Local prompt → ssh one-shot → remote output → local prompt** — the
   simplest possible SSH round-trip, with no interactive shell started
   on the remote side.
2. **SSH transport is transparent** — the engine sees a flattened byte
   stream with no special framing; the local command line, the remote
   `hi` output, and the returning local prompt land on consecutive rows
   of the main buffer.
3. **`altScreen: false` throughout** — non-interactive ssh never enters
   alt-screen. The invariant holds across every checkpoint.

## Scenario

| row | content                    | notes                                 |
|-----|----------------------------|---------------------------------------|
| 0   | `$ ssh localhost echo hi`  | local prompt + typed command          |
| 1   | `hi`                       | remote `echo hi` output               |
| 2   | `$ `                       | local prompt after ssh disconnects    |

## Checkpoints

| # | description                                |
|---|--------------------------------------------|
| 1 | command line visible on row 0              |
| 2 | `hi` output on row 1; cursor advanced      |
| 3 | local `$ ` back on row 2; cursor at col 2  |
| 4 | altScreen stayed false; scrollback empty   |

## Files

| file | purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream |
| `checkpoints.json` | 4 checkpoints — row 0 command, `hi` output, local prompt back, scrollback invariant |
| `meta.json` | cols=60, rows=8, synthetic, `kind='synthetic'`, `id='C-NET-01'`, `snapshotFormatVersion=1` |
| `build-fixture.mjs` | Generator script (idempotent) |

## Why synthetic?

Real openssh negotiation adds terminfo queries, channel setup bytes, and
optional first-connect host-key prompts. None of those are load-bearing
for the "ssh is transparent to the engine" contract under test. The
minimal synthetic stream keeps the row layout predictable and
human-reviewable.

## Epic dependency

Green today. No outstanding epic blocks.
