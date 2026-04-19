# Scenario: `bold_text`

- **Title**: `sgr-bold-then-reset`
- **Harness**: replay (golden-stream)
- **Fixture kind**: synthetic (hand-constructed byte stream)

## Precondition

Fresh 24×80 grid. Main buffer active. Cursor at `(0, 0)`. SGR pen is
default.

## Input

`ESC [ 1 m b o l d ESC [ 0 m \n`

```
\x1b[1m bold \x1b[0m \n
```

Encoded byte length: 13. Semantics:

- `\x1b[1m` — set bold attribute (`CellAttrs::BOLD`).
- `bold` — four ASCII cells with the bold attribute set.
- `\x1b[0m` — full SGR reset.
- `\n` — line feed.

## Expected observable state

- Row 0, cols 0..3 contain `b`, `o`, `l`, `d` with `attrs` containing
  `CellAttrs::BOLD`.
- Row 0, cols 4..79 are blank with default attrs.
- Pen ends in fully-reset state.
- No mode changes emitted.

## Purpose

Pins SGR attribute handling and the reset semantics of `SGR 0`. The
fixture uses the `BOLD` attribute (a bitflags field) rather than a
palette-8 color variant — `quanta_vt::Color::Palette8(u8)` cannot
currently be round-tripped through `serde_json` due to an upstream
serde limitation on tagged newtype variants wrapping primitives. Once
the engine's `Color` serde representation is updated (e.g., to
`#[serde(untagged)]` or to wrap the inner value in a struct), a
dedicated `red_text` fixture that exercises palette-8 colors can be
added alongside this one.

## Captured

**Captured**: synthetic / N/A host / en_US.UTF-8 / 2026-04-19 / by @epic-g / EPIC-G initial pass
