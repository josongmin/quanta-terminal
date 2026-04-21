# C-IME-03: Chinese pinyin IME post-commit render

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Mirrors C-IME-01 (Korean) / C-IME-02 (Japanese) for the CJK unified
ideograph range. Post-IME-commit PTY bytes for `你好世界!` (4 hanzi +
1 narrow bang) must render as:

- 7 narrow ASCII cells for `$ echo ` (cols 0..6).
- 4 wide hanzi pairs (cols 7..14: `[2,0, 2,0, 2,0, 2,0]`).
- 1 narrow `!` cell at col 15.
- Cursor advances cleanly; after newline it's at row 1 col 0.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~40 bytes) |
| `checkpoints.json` | 3 checkpoints — row 0 widths, row 1 echo, final prompt |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Out of scope

Pinyin state machine (candidate selection, tone input, commit on enter)
is host-layer concern; this fixture tests only the emulator's render
contract for CJK wide cells.

## Epic dependency

Green post CJK width classification in the emulator (already shipped).
No pending markers.
