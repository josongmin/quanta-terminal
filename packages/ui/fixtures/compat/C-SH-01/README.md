# C-SH-01: bash baseline

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Pure main-buffer shell loop. No alt-screen, no SGR. Four command turns
(`ls`, `cd /tmp`, `pwd`, `echo $?`) with their outputs, followed by a
parked prompt.

Exercises:

1. Plain printable-text + `\r\n` cursor advancement.
2. Multi-turn transcript rendering (8 rows used out of 12).
3. Scrollback invariant — no rows evicted, so the scrollback ring stays
   at zero.

If this fixture regresses, the baseline `feed()` → grid path is broken.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (78 bytes) |
| `checkpoints.json` | 6 checkpoints — cursor + row projections per command turn |
| `meta.json` | cols=40, rows=12 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |
