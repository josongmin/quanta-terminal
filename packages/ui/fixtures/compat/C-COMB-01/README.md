# C-COMB-01: git log | less | head -20

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Pipe + pager + head combinator. `less` enters the alt buffer, paints
20 rows of commit-log-like text, and exits on EOF from `head`. The
main buffer is restored.

Load-bearing invariant: **alt-buffer content never leaks into the main-
buffer scrollback ring** — this is the same invariant as C-PG-01, re-
asserted in a PIPED scenario (different byte-stream shape, same
contract).

Scenario:
1. Prompt `$ git log | less | head -20\r\n`.
2. DECSET 1049h + CSI 2J + CSI H (less enters alt + clears).
3. 20 rows of `NNNNNNN 2026-04-20 commit subject N`.
4. DECSET 1049l (less exits on EOF).
5. Post-exit prompt `$ ` on the next main-buffer row.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~800 bytes) |
| `checkpoints.json` | 4 checkpoints — alt enter, commit rows painted, main restored, scrollback invariant |
| `meta.json` | cols=80, rows=24 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |
