# Scenario: `cursor_save_restore`

- **Title**: `decsc-decrc-cursor-preservation`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`.

## Input

```
\x1b[5;10H    -- CUP: move cursor to row 5, col 10 (1-based → row 4, col 9 zero-based).
START         -- 5 ASCII cells.
\x1b7         -- DECSC: save cursor, SGR pen, charset, origin mode.
\x1b[20;40H   -- CUP: move cursor to row 20, col 40 (1-based).
MIDDLE        -- 6 ASCII cells.
\x1b8         -- DECRC: restore saved state.
```

Encoded byte length: 30.

## Expected observable state

- Row 4 (zero-based) has `START` starting at col 9; cursor after the
  first write sat at col 14; DECSC (`\x1b7`) captured
  `(row=4, col=14)`.
- Row 19 has `MIDDLE` starting at col 39.
- Final cursor position: **restored** to `(row=4, col=14)` — the
  position saved by DECSC.
- No mode changes emitted.

## Purpose

Verifies DECSC (`ESC 7`) / DECRC (`ESC 8`) correctly save and restore
the cursor across intervening cursor motion and writes. This is the
VT100-canonical save/restore path; `CSI s` / `CSI u` (ANSI SCO
SC/RC) is a different convention and is tracked as a separate
follow-up fixture once the engine honors it.

## Captured

**Captured**: synthetic / N/A host / en_US.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
