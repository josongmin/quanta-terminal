# Scenario: `wrap_korean`

- **Title**: `wrap-decawm-korean`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`. DECAWM on
(default). Width classifier treats `한` (Hangul, U+D55C) as
[`CellWidth::Two`].

## Input

45 repetitions of `한` (UTF-8: `ED 95 9C`). Encoded byte length: 135.

At 80 columns, a width-2 grapheme fits 40 per row. Writing 45 forces
DECAWM to soft-wrap at the right edge of row 0; the 41st grapheme lands
at row 1 col 0, and row 1 carries the soft-wrap `continuation` flag.

## Expected observable state

- Row 0 cols 0..79 filled with 40 Korean graphemes (each occupies two
  cells: the base cell holds `한` with `width = two`; the right half
  has an empty grapheme, `width = zero`, and `WIDE_CONTINUATION` set).
- Row 1 cols 0..9 contain 5 more Korean graphemes (columns 0-9).
- Row 1's `continuation` flag is `true`.
- Cursor ends inside row 1.
- No mode changes emitted.

## Purpose

Exercises the DECAWM wrap path with a wide-cell grapheme — the exact
scenario that retired RFC §22 failure modes #6/#7 (continuation-flag
invariants) during EPIC-B implementation. Keeps the fixture present so
a regression cannot silently land.

## Captured

**Captured**: synthetic / N/A host / ko_KR.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
