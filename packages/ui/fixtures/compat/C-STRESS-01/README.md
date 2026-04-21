# C-STRESS-01: tail -f /dev/urandom | base64 (volume stress)

**Status:** synthetic (hand-authored byte stream). Will be replaced by a
real recording once `tools/compat-record` lands (Plan 0005 Epic ε6).

## What this fixture asserts

Continuous high-volume main-buffer output. 100 rows of ~76-char
base64-lookalike text + `\r\n` scroll the viewport repeatedly; the
scrollback ring captures the 78 rows that fall off the top. `^C`
interrupts cleanly.

Exercises:

1. Main-buffer scroll-up + scrollback-ring growth under steady volume.
2. `altScreen` stays `false` throughout.
3. Final `^C\r\n` + `$ ` prompt parks at row 23, col 2 with
   `scrollback.rowCount === 79`.

Global `byteAccounting.droppedBytes === 0` is enforced by harness-audit
(§byte-accounting) — no per-checkpoint assertion needed.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~7.8 KiB) |
| `checkpoints.json` | 5 checkpoints — 10-row growth, 100-row tail, alt-false, scrollback pin, post-interrupt prompt |
| `meta.json` | cols=80, rows=24 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |
