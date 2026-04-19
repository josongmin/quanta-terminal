# Scenario: `alt_screen_enter_exit`

- **Title**: `alt-screen-1049-enter-content-exit`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`. No modes set
beyond defaults.

## Input

```
\x1b[?1049h    -- DECSET 1049: save cursor, enter alt, clear alt.
\x1b[H         -- home cursor.
ALTENT         -- 6 ASCII cells on alt buffer.
\x1b[?1049l    -- DECRST 1049: restore cursor, exit alt, back to main.
```

Encoded byte length: 21.

## Expected observable state

- **Post-exit** (what the end-of-feed snapshot captures):
  - Active buffer is `Main`.
  - Row 0 is blank (no `ALTENT` leak from alt into main).
  - Cursor restored to `(0, 0)` (the pre-enter position).
  - `modes.alt_screen` is `false`.
- Mid-feed ordering invariant (verified by the harness via the returned
  `Vec<TerminalEvent>`, cross-referenced from the existing
  `alt_screen.rs` test `alt_screen_mode_changed_before_cell_delta`):
  - `ModeChanged(AltScreenFull, true)` is emitted BEFORE any `GridDelta`
    that writes `ALTENT` to the alt buffer.
  - `ModeChanged(AltScreenFull, false)` is emitted on exit.

## Purpose

Pins the alt-screen enter/exit contract — the most visited escape
sequence in the compat matrix (`vim`, `tmux`, `less`, `htop`, …). If
this fixture regresses, every alt-screen program's golden will
regress. Treat this as the canary.

## Captured

**Captured**: synthetic / N/A host / en_US.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
