# Scenario: `hello_world`

- **Title**: `hello-world-ascii`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream, not captured from a real program)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`. No modes set
beyond defaults (`auto_wrap = true`, everything else off).

## Input

Raw bytes: the ASCII string `hello` followed by a line-feed (`0x0A`).

```
hello\n
```

Encoded byte length: 6.

## Expected observable state

- Row 0, cols 0..4 contain the graphemes `h`, `e`, `l`, `l`, `o`.
- Row 0, cols 5..79 are blank.
- Rows 1..23 are entirely blank.
- Cursor advances by 5 on the `hello` then the `\n` applies LF + CR
  semantics (whether this grid emits implicit CR on LF is engine
  policy; the golden captures whatever the current engine does, which
  is the definition of "correct" for this replay harness).
- No mode changes emitted.

## Purpose

Baseline smoke: proves the harness + pipeline works end-to-end before
any real feature is exercised. If this fixture fails, the harness
itself is broken; look at `compat_harness.rs` first.

## Captured

**Captured**: synthetic / N/A host / en_US.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
