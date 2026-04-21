# C-MON-03: watch -n 0.1 date (continuous repaint stress)

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 3, Agent-P). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

Pure repaint volume. `watch -n 0.1 date` repaints the entire screen
every 100 ms, and this fixture streams 60 frames (~6 simulated seconds).
The single load-bearing invariant is that rapid alt-buffer repaints
leave the main-buffer scrollback ring **empty**.

1. DECSET 1049h → alt buffer, clear, home.
2. 60 frames, each a `CSI H` + header row + centred date row. The date
   line's seconds field ticks so every frame's bytes differ.
3. CP 2: after 10 frames, row 0 still shows the header.
4. CP 3: after 60 frames, `scrollback.rowCount === 0`.
5. C-c → 1049l → main buffer restored.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~5 KiB for 60 frames) |
| `checkpoints.json` | 4 checkpoints — alt enter, 10-frame header, 60-frame scrollback, alt exit |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real watch output is trivially reproducible, but recording needs the
`tools/compat-record` harness (still pending). A hand-authored 60-frame
stream with a stable header + varying date line still exercises the
rapid-repaint path we care about.

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer) + α3 (scrollback ring).
No pending markers.
