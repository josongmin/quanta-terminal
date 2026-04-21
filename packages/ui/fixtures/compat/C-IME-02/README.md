# C-IME-02: Japanese IME post-commit render

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Mirrors C-IME-01 (Korean) for the Japanese hiragana range. Post-IME-
commit PTY bytes for `こんにちは!` (5 hiragana + 1 narrow bang) must
render as:

- 7 narrow ASCII cells for `$ echo ` (cols 0..6).
- 5 wide hiragana pairs (cols 7..16: `[2,0, 2,0, 2,0, 2,0, 2,0]`).
- 1 narrow `!` cell at col 17.
- Cursor ends at col 18.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~40 bytes) |
| `checkpoints.json` | 2 checkpoints — row 0 post-commit widths, row 1 echo output |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Out of scope

IME state machine (preedit buffer, commit-on-switch, candidate window)
is host-layer concern; this fixture tests only the emulator's render
contract for CJK wide cells.

## Epic dependency

Green post CJK width classification in the emulator (already shipped).
No pending markers.
