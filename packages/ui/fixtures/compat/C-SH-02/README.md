# C-SH-02: zsh long-prompt wrap at cols=80

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

A 91-character zsh-style prompt at `cols=80` must wrap: cols 0..79 fill
row 0 and the remaining 11 chars land on row 1 cols 0..10 (DECAWM
auto-wrap on the 81st printable). A command echoes on the wrapped row,
output fills the next row, and a second prompt re-wraps identically
deeper in the transcript.

Checkpoints assert:

1. Post-prompt: row 0 full, row 1 holds the 11-char continuation,
   cursor at row 1 col 11.
2. After `ls` typed: row 1 tail = continuation + `ls`, cursor at
   col 13.
3. After second prompt: rows 3 + 4 hold the re-wrapped prompt.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | 199 bytes |
| `checkpoints.json` | 3 checkpoints |
| `meta.json` | cols=80, rows=24 |
| `build-fixture.mjs` | Regenerator |
