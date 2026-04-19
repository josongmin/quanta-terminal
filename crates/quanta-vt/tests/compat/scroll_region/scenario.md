# Scenario: `scroll_region`

- **Title**: `decstbm-scroll-inside-region-only`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`. DECSTBM
region is full-screen (rows 1..24).

## Input

```
\x1b[3;10r       -- DECSTBM: set scrolling region rows 3..10 (1-based).
\x1b[3;1H        -- CUP to row 3 col 1 (inside the region, at its top).
LINE_01\r\n      -- 7 cells + CRLF; repeated for LINE_02..LINE_15.
...              -- (15 lines total.)
```

Encoded byte length: 148 (7 cells + CRLF × 15 lines = 135, plus the
two escape sequences = 148).

Region height is 8 rows (3..10 inclusive). Writing 15 lines means
rows 1..7 scroll out of the region; rows 8..15 remain visible inside
it. Rows 0..1 (above the region) and rows 10..23 (below the region)
must remain blank — that's the invariant this fixture pins.

## Expected observable state

- Rows 0..1 (zero-based) are blank — DECSTBM must not touch outside
  its region.
- Rows 2..9 hold the tail-eight `LINE_NN` strings (LINE_08..LINE_15
  depending on exact scroll semantics; the blessed golden is whatever
  the engine produces, since the harness is strict).
- Rows 10..23 are blank.
- Cursor ends inside the region.
- No mode changes emitted.

## Purpose

Pins the DECSTBM scroll-region invariant: scrolling must not leak
outside the region. This is the semantic that `vim` relies on for
split windows and `less` relies on for its status-line preservation.

## Captured

**Captured**: synthetic / N/A host / en_US.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
