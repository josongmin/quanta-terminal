# C-MUX-02: tmux-in-ssh (depth-2)

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 3, Agent-P). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

Two nesting layers: `local bash → ssh localhost → remote shell → tmux`.
The engine sees a flat PTY byte stream, so the nesting is invisible to
it — this fixture just proves that a single tmux alt-screen cycle
round-trips cleanly inside an ssh session.

1. Local `$ ssh localhost\r\n` → remote `Last login: ...` banner +
   remote `$ ` prompt (main buffer).
2. Remote `tmux new -s demo\r\n` → DECSET 1049h → alt buffer + inner
   `$ ` prompt + status line (SGR 7 inverse).
3. Inner `exit` → DECSET 1049l → main buffer restored; remote `$ `
   prompt returns below the `tmux new` command line.
4. Remote `exit` → local `$ `.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~120 bytes) |
| `checkpoints.json` | 5 checkpoints — banner, alt enter, alt content, alt exit, local return |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real ssh + tmux recordings include terminfo negotiation, bracketed-paste
enable, motd, and other non-load-bearing chatter. A hand-authored
stream with just the round-trip bytes is easier to review and matches
the same engine invariants.

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer). No pending markers.
