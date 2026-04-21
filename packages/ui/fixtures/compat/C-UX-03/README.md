# C-UX-03: bracketed-paste round-trip

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Bracketed-paste mode (DECSET 2004) wraps pasted text in `CSI 200 ~`
(start) and `CSI 201 ~` (end). Those markers are CONTROL bytes — they
MUST NOT appear as printable characters in the grid. The payload
between them renders normally.

Scenario:
1. Prompt `$ echo ` (partial command typed).
2. `CSI 200 ~` paste-start.
3. Pasted text `hello world!` + `\r\n`.
4. `CSI 201 ~` paste-end.
5. Synthetic shell echo `hello world!\r\n`.
6. Final prompt `$ `.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~50 bytes) |
| `checkpoints.json` | 3 checkpoints — paste rendered, echo rendered, final prompt |
| `meta.json` | cols=40, rows=10 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |

## Note on C-RP-02

C-RP-02 (node REPL with bracketed paste) covers the paste path in a
REPL-specific context. C-UX-03 covers the generic UX case with a
minimal scenario so the UX invariant is locked independently of node
REPL quirks.
