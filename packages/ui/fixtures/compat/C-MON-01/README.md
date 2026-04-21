# C-MON-01: top 30-second session

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 1/2, Agent-H). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

The TUI "repaint-in-alt" invariant: a program that cycles many frames
through the alt buffer must leave the main-buffer **scrollback ring
empty**. Real top is a stress test of alt-buffer repainting; three
frames are enough to prove the invariant without growing the fixture.

1. Before 1049h, the main buffer holds `$ top` on row 0.
2. 1049h enters alt; `mode.alt_screen === true`.
3. Frame 1: top header (row 0: `top - 21:17:02 up 1 day...`), task
   summary (rows 1-4), column header (row 5), 18 process rows.
4. Frame 2: CSI 2J + repaint, with a couple of %CPU columns nudged.
5. Frame 3: CSI 2J + repaint again.
6. **Load-bearing**: throughout frames 1-3, `getScrollback().rows` has
   length 0. Alt-buffer paints are ephemeral; only main-buffer row
   evictions feed the ring.
7. 1049l exits alt. Main buffer restores `$ top`; cursor back at
   row 1 col 0.
8. Shell reprints `$ `.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~6 KiB) |
| `checkpoints.json` | 5 checkpoints — cursor / mode / row projections + scrollback count |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real top output varies with kernel, process list, refresh interval, and
locale. A three-frame synthetic stream still exercises the alt-repaint
path, plus the specific scrollback invariant — which is what matters.

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer) + α3 (scrollback ring). No
pending markers.
