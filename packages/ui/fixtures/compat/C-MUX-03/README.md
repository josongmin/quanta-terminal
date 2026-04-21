# C-MUX-03: tmux-in-ssh-in-tmux (depth 3)

**Status:** synthetic (hand-authored byte stream). This fixture
documents an explicit engine-contract decision, not just a regression.

## What this fixture asserts

Triple nesting: `local bash → outer tmux → ssh localhost → remote shell
→ inner tmux`. Our emulator has exactly **ONE** alt buffer, not a
stack, so:

1. Outer tmux DECSET 1049h → `altScreen: false → true`. (CP 1)
2. Remote login banner + remote prompt paint inside the outer alt
   buffer. (CP 2)
3. Inner tmux DECSET 1049h is a **no-op** — engine is already in alt;
   `altScreen` stays `true`. The inner tmux's paint lands on the same
   alt buffer, overwriting the outer tmux's display. (CP 3)
4. Inner tmux DECSET 1049l exits alt **unconditionally**:
   `altScreen: true → false`. (CP 4)
5. Main buffer now shows the pre-outer-tmux content (`$ tmux` on row 0),
   **not** the outer tmux's display. This is the expected, documented
   behaviour of a no-stack alt-buffer engine. (CP 5)

## The engine contract (current)

> "Our alt buffer is a single flip, not a stack. Nested 1049h is a
> no-op; 1049l always exits alt; restoring the main buffer means
> restoring what was there BEFORE the first 1049h, regardless of how
> many times 1049h was seen."

This matches xterm. `tmux` / `screen` work around it by running their
own in-memory virtual terminal so nested programs never see the outer
tmux's 1049h.

## Future work (P1 ModeStack)

Plan 0005 P1 includes a ModeStack epic that will add a real stack for
alt buffer + origin mode + other one-shot modes. When that lands,
this fixture's CP 3 / CP 5 expectations will need to flip — either to
"inner 1049l leaves outer tmux's display intact" (true stack) or to
"inner 1049l pops one level". The fixture provides a single place to
make that decision explicitly.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~200 bytes) |
| `checkpoints.json` | 5 checkpoints — outer alt enter, remote banner in alt, inner 1049h no-op, inner 1049l exit, main-buffer restoration |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer). **Pending flip** post P1
ModeStack — see above.
