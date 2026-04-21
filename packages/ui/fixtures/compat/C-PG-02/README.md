# C-PG-02: man git-log

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Same alt-screen lifecycle as C-PG-01 (less), but with man-style styling
layered on:

1. Plain header row `GIT-LOG(1)   Git Manual   GIT-LOG(1)`.
2. `NAME` and `SYNOPSIS` section headers in SGR 1 (bold).
3. Status line `Manual page git-log(1) line 1` in SGR 7 (reverse video).

Row-level `sgrDigest` assertions lock the bold + inverse attributes
byte-for-byte. If the engine drops SGR 1 or SGR 7 across the alt-buffer
paint, the digests change.

## Scenario

1. Main: `$ man git-log\r\n`.
2. DECSET 1049h + clear + home.
3. Header row on row 0 (plain text).
4. `NAME` bold on row 2.
5. Description on row 3.
6. `SYNOPSIS` bold on row 5.
7. Synopsis line on row 6.
8. Status line on row ROWS-1 inverse.
9. `q` → DECSET 1049l. Main restores.
10. Post-exit prompt.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | 265 bytes |
| `checkpoints.json` | 6 checkpoints — two carry `sgrDigest` |
| `meta.json` | cols=60, rows=10 |
| `build-fixture.mjs` | Regenerator |
