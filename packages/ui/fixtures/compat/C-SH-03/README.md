# C-SH-03: fish autosuggest ghost text

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Fish's inline autosuggestion: the shell echoes the user's typed prefix
`$ ls ` then paints `/tmp` in SGR 90 (bright-black fg) and pulls the
cursor back 4 cols with `CSI 4 D` so the next keystroke overwrites the
ghost span.

The load-bearing assertion is a row-level `sgrDigest` on row 0: cols
0..4 have default fg, cols 5..8 carry fg=bright:0. If SGR 90 is
dropped, merged, or misapplied across the cursor-back boundary, the
digest changes.

Checkpoints assert:

1. Row 0 text `$ ls /tmp` with the ghost-span digest.
2. Cursor parked at row 0 col 5 (after `$ ls `).

## Files

| File | Purpose |
|---|---|
| `input.bytes` | 22 bytes |
| `checkpoints.json` | 2 checkpoints |
| `meta.json` | cols=40, rows=6 |
| `build-fixture.mjs` | Regenerator |
