# C-RP-02: node REPL bracketed-paste multi-line

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-T). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

1. **Bracketed-paste delimiters are transparent** — `CSI 200~` /
   `CSI 201~` bytes are present in `input.bytes` but the engine
   currently has no bracketed-paste state; they fall through the
   parser's "garbage — drop the CSI" branch (VtEmulator.ts L~740) and
   contribute NOTHING to the grid.
2. **Pasted content renders inline** — all four pasted lines land on
   consecutive rows of the main buffer, with the first line appended
   after the `> ` primary prompt.
3. **Node prompt shape** — `> ` (primary) pinned on the expected rows.
4. **Clean `.exit`** returns the local `$ ` prompt.

## Scenario

| row | content                         |
|-----|---------------------------------|
| 0   | `$ node`                        |
| 1   | `Welcome to Node.js v20.9.0.`   |
| 2   | `Type ".help" for more information.` |
| 3   | `> const add = (a, b) => {`     |
| 4   | `  return a + b;`               |
| 5   | `};`                            |
| 6   | `add(2, 3)`                     |
| 7   | `5`                             |
| 8   | `> .exit`                       |
| 9   | `$ `                            |

## Checkpoints

| # | description                                                   |
|---|---------------------------------------------------------------|
| 1 | node banner visible; primary `> ` at row 3                    |
| 2 | prompt-shape assertion (`> ` on row 3)                        |
| 3 | paste landed on rows 3-6; result `5` on row 7; next `> `      |
| 4 | `$ ` back after `.exit`; altScreen stayed false; scrollback empty |

## Files

| file | purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (includes `CSI 200~`/`CSI 201~` markers) |
| `checkpoints.json` | 4 checkpoints |
| `meta.json` | cols=60, rows=12, `kind='synthetic'`, `id='C-RP-02'`, `snapshotFormatVersion=1` |
| `build-fixture.mjs` | Generator script (idempotent) |

## Judgment call: paste markers yes, line-by-line echo no

Real node-v20 REPL echoes each pasted line prefixed with `... ` when
the block is incomplete, prints `undefined` after the `};` assigns the
arrow, and only then emits `5` on the next `add(2, 3)` evaluation. That
realistic stream adds 5+ rows of state drift that aren't load-bearing
for the contract under test ("paste delimiters don't corrupt the
visible transcript").

We keep the stream minimal: paste content lands as raw text, result
`5` on its own row, next `> `. When the α2 extension wires up
bracketed-paste state tracking, the visible transcript here MUST NOT
regress — this fixture is the canary.

## Epic dependency

Green today. Future α2 work on bracketed-paste state must preserve the
visible-transcript shape here.
