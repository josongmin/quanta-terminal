# C-UX-02 — resize cycle

Plan 0005 P0 Gate #6 closing fixture. Exercises the compat harness
in-stream `resize` hook across 10 alternating resize operations between
the fixture baseline (80×24) and a stretched dim (200×50).

## Contract

- After each `emulator.resize(rows, cols)` the main buffer REFLOWS:
  cells at `(r, c)` where `r < min(oldRows, newRows)` and
  `c < min(oldCols, newCols)` are copied into the new grid; the
  remaining cells are blank-filled. (`VtEmulator.resize()`.)
- Alt buffer clears on resize per xterm — this fixture stays on main
  buffer end-to-end, so the alt-clear contract is asserted indirectly
  (we never enter alt; if a regression caused a spurious alt-flip
  mid-resize, row content would go missing on the next cycle).
- Scrollback ring is not touched by resize; the fixture pins
  `scrollback.rowCount === 0` on every checkpoint as a canary.

## Cycle pattern

All 11 checkpoints fire at the SAME byte-offset (end of stream). We
stream a minimal `ls` transcript (10 output rows + prompts, 78 bytes)
and then cycle resize dimensions, each time re-projecting the pinned
rows:

| CP  | Dimensions | Purpose                                  |
| --- | ---------- | ---------------------------------------- |
| 0   | 80×24      | Baseline anchor (no `resize` hook)       |
| 1   | 200×50     | First stretch — verifies reflow grows grid |
| 2   | 80×24      | First shrink — verifies reflow truncates cleanly |
| 3   | 200×50     | (cycle 2/5)                              |
| 4   | 80×24      | (cycle 2/5)                              |
| 5   | 200×50     | (cycle 3/5)                              |
| 6   | 80×24      | (cycle 3/5)                              |
| 7   | 200×50     | (cycle 4/5)                              |
| 8   | 80×24      | (cycle 4/5)                              |
| 9   | 200×50     | (cycle 5/5)                              |
| 10  | 80×24      | (cycle 5/5) — clean exit dim             |

Per checkpoint the harness calls `emulator.resize(rows, cols)` BEFORE
the diff fires, so `selected_rows` assertions see the post-resize grid.
The diff path reads `emulator.getDimensions()` (not `meta.*`) when
validating row indices and projecting rows — that lets this fixture's
200×50 checkpoints project widths arrays of length 200 while staying
compatible with every other fixture (their unchanged dims continue to
match `meta`).

## Files

- `meta.json` — baseline dims 80×24, `kind: synthetic`, pins
  `snapshotFormatVersion: 1`.
- `input.bytes` — 78 bytes (ASCII; no escape sequences).
- `checkpoints.json` — 11 entries; see table above.
- `build-fixture.mjs` — regenerates `input.bytes` + `checkpoints.json` +
  `meta.json` from the scenario parameters. Idempotent.

Regenerate with:

```
node packages/ui/fixtures/compat/C-UX-02/build-fixture.mjs
```
