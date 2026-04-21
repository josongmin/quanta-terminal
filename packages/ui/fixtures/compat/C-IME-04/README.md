# C-IME-04 — European dead-key composition

Companion to C-IME-01 (wide CJK). This fixture verifies that BMP Latin-1
accented characters committed by the host's dead-key IME (e.g. `'` + `e`
→ `é`) render as **narrow width-1 graphemes**, not as wide-leading +
continuation pairs.

## Byte stream

1. `$ echo ` — 7-char ASCII prompt. Cursor lands at col 7.
2. `café résumé` — 11 graphemes, all width 1 (including the three `é`
   bytes, each encoded as UTF-8 `0xC3 0xA9`). Cursor advances to col 18.
3. `\r\n` + shell echo `café résumé\r\n` — row 1 holds the output.

## Load-bearing assertion

CP 2's `widths` array on row 0 is **all 1s**. If the classifier ever
misclassifies BMP Latin-1 as wide (East Asian Width `W`/`F`), col 11 /
16 / 20 would flip to `2` with a `0` continuation, and `text` would drop
the affected grapheme. The diff output highlights the exact column that
went wrong, so a regression here is trivially localisable.

## Scope

In-scope: post-commit byte-stream rendering, width classification, cursor
advance.

Out of scope: the dead-key state machine itself (pre-commit composition
of `'` + `e` into `é`). That's covered by
`packages/ui/src/features/input/ime/__tests__/...`.

## Regeneration

```
node packages/ui/fixtures/compat/C-IME-04/build-fixture.mjs
```
