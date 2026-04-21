# C-MUX-01: tmux new + split + detach

**Status:** synthetic (hand-authored byte stream). Will be replaced by a
real `tmux` recording once `tools/compat-record` lands (Plan 0005
Epic ε §6).

## Category note

`mux` is not a `CompatCategory` variant in `registry.ts`. tmux is a
full-screen TUI application (it takes over the alt buffer, paints panes
+ a status line), so this fixture is bucketed under `'tui'`. The
fixture ID prefix `C-MUX-*` keeps the compat matrix readable.

## What this fixture asserts

1. **Alt-buffer round trip** — DECSET 1049h/l cycle with a status line,
   just like C-PG-01 and C-MON-01 but sandwiching a split paint.
2. **Status line SGR** — `[demo] 0:zsh*` rendered with SGR 7 inverse;
   `sgrDigest` asserts it is preserved across both the initial paint
   and the split repaint.
3. **Split repaint visible structure** — after a simulated `C-b "`
   split-horizontal, row 0 holds the upper pane prompt and row N/2 holds
   the lower pane prompt. Real tmux redraws the entire visible area; we
   synthesize the same end-state with `CSI 2J` + absolute moves.
4. **Clean detach** — `C-b d` emits DECSET 1049l; main buffer restores
   with `$ tmux new -s demo` on row 0.

## Scenario

1. Shell prompt `$ tmux new -s demo\r\n`.
2. DECSET 1049h; clear + home.
3. Paint upper pane: `$ echo hello` on row 0, `hello` on row 1,
   `$ ` on row 2.
4. Status bar on last row (reverse video): `[demo] 0:zsh*`.
5. Split-horizontal: erase display, repaint upper pane prompt on row 0,
   lower pane prompt on row N/2, status bar unchanged.
6. DECSET 1049l; post-exit shell prompt.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~158 bytes) |
| `checkpoints.json` | 5 checkpoints — alt entry, initial paint + status SGR, split paint, detach + main restore, post-exit |
| `meta.json` | cols=40, rows=10, synthetic zsh-like |
| `build-fixture.mjs` | Generator script |

## Why synthetic?

Real tmux setup is ~2 KiB of terminfo + bracketed paste + cursor-style
negotiation. The engine contract under test (alt buffer + absolute
cursor moves + SGR 7 paint) doesn't care whether the bytes came from
real tmux. Synthetic keeps the fixture reviewable.

## Epic dependency

Green post Epic α.
