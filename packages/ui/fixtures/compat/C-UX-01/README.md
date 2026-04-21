# C-UX-01: `clear` behaviour

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

The `clear` command emits `CSI H` + `CSI 2 J` in some order (xterm
terminfo; some entries reverse the order). The combined effect is:

- visible grid cleared,
- cursor homed to (0, 0),
- scrollback ring SURVIVES (no `CSI 3 J`).

Scenario:
1. `$ ls\r\n` + 5-line output + prompt.
2. User types `clear\r\n`.
3. `clear` emits `CSI H` + `CSI 2 J`.
4. New prompt `$ ` at row 0.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~60 bytes) |
| `checkpoints.json` | 4 checkpoints — pre-clear, post-clear blank, post-clear prompt, alt invariant |
| `meta.json` | cols=40, rows=12 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |

## Note on `CSI 3 J`

Modern terminfo entries sometimes emit `CSI 3 J` (erase scrollback too)
as part of `E3` / `clear-extended`. This fixture covers the baseline
`clear` only. A follow-up fixture can cover `CSI 3 J` scrollback-erase
semantics explicitly.
