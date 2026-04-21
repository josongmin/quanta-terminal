# C-IME-01: Korean 2-set IME render side

**Status:** synthetic (hand-authored byte stream). Post-commit bytes
only — no IME state machine in scope.

## Scope clarifier

This fixture tests **the emulator's render side** of CJK wide cells:
once the IME has committed a syllable (e.g. ㅇ + ㅏ + ㄴ → `안`), the
PTY sees raw UTF-8 bytes and the engine must render them as
**width-2 leading + width-0 continuation** cells.

The IME state machine itself (jamo composition, backspace handling,
commit-on-language-switch) is covered separately by
`packages/ui/src/features/input/ime/__tests__/korean-2set.test.ts`.

## What this fixture asserts

Feeding the UTF-8 bytes for `$ echo 안녕하세요!` (no IME involved — we
write post-commit bytes directly) results in:

- Row 0 cols 0..6: narrow ASCII (prompt `$ echo `).
- Row 0 col 7: width-2 leading, grapheme `안`.
- Row 0 col 8: width-0 continuation (no grapheme).
- …repeated for `녕`, `하`, `세`, `요` at cols 9,10 / 11,12 / 13,14 /
  15,16.
- Row 0 col 17: narrow `!` (width 1).
- Cursor advances by 2 per hangul; ends at col 18 after `!`.
- On `\r\n` + echo output, row 1 holds `안녕하세요!` with the same
  width pattern.

The load-bearing assertion is the `widths` array on row 0 at CP 5:

```
[1,1,1,1,1,1,1, 2,0, 2,0, 2,0, 2,0, 2,0, 1, 1,1,1,1,...]
```

Any regression in the width classifier (misclassifying hangul as
narrow) or in the emulator's wide-cell continuation logic (dropping the
width-0 slot) breaks this in a diff-able way.

## No sgrDigest

IME commit doesn't touch SGR state; all cells stay default. Widths is
the non-trivial field here.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw UTF-8 byte stream (~43 bytes: prompt + 5 hangul × 3 UTF-8 bytes + `!` + `\r\n` + echo) |
| `checkpoints.json` | 5 checkpoints — prompt, first hangul, all 5, `!`, echo output |
| `meta.json` | cols=40, rows=4, zsh |
| `build-fixture.mjs` | Generator script |

## Why synthetic?

The IME is a user-input concern; from the engine's POV the incoming
bytes are plain UTF-8. Writing post-commit bytes directly isolates the
render contract without coupling to the IME state machine.

## Epic dependency

Green post Epic α2 (alt buffer — not directly exercised here, but
scrollback + wide-cell plumbing both flow through α2/α3). Width
classifier + wide-cell storage have been stable since before Plan 0005.
