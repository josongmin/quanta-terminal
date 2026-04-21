# C-PG-01: less /etc/passwd

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 2, Agent-H). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

The pager half of the DECSET 1049h / 1049l alt-screen contract, plus
three in-alt repaint patterns that less uses in real sessions:

1. Before 1049h, the main buffer holds the shell prompt and the
   `less /etc/passwd` command.
2. 1049h enters alt; the engine clears; `mode.alt_screen === true`.
3. less paints page 1 of the file (23 content rows + reverse-video `:`
   status prompt).
4. User presses `j`: less erases and repaints, now starting at the 2nd
   entry — row 0 no longer says `root:`.
5. User presses `G`: less erases and repaints again; status row shows
   `(END)`.
6. 1049l exits alt. **Main buffer must restore verbatim** —
   `$ less /etc/passwd` on row 0, cursor back at row 1 col 0.
7. Shell reprints `$ `.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~4 KiB) |
| `checkpoints.json` | 6 checkpoints — cursor / mode / row projections |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real `less` recordings vary with terminfo negotiation, $LESS env vars,
locale, and less version. A synthetic stream lets reviewers read every
byte of the scenario (see `build-fixture.mjs`) and still exercises the
same emulator code paths: DECSET 1049, CSI cursor-move, CSI erase-display,
SGR reverse-video.

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer) + α3 (scrollback ring). No
pending markers.
