# C-RP-01: python3 multi-line def

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-T). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

1. **Primary prompt `>>> `** on row 3 after the banner.
2. **Continuation prompt `... `** after `def foo():`, and again after
   the indented `    return 42` line. Pins the classic Python REPL
   multi-line block behaviour.
3. **Call + result** — `foo()` → `42` on its own row, followed by the
   next `>>> `.
4. **Clean `exit()`** returns the local `$ ` prompt; altScreen stays
   false; scrollback ring stays empty.

## Scenario

| row | content                   | notes                         |
|-----|---------------------------|-------------------------------|
| 0   | `$ python3`               | local launch                  |
| 1   | `Python 3.11.5 (main, Aug 24 2023) on darwin` | banner line 1   |
| 2   | `Type "help", "copyright" or "license" for info.` | banner line 2 |
| 3   | `>>> def foo():`          | primary prompt + def line     |
| 4   | `...     return 42`       | continuation + body           |
| 5   | `... `                    | continuation (user blank line closes def) |
| 6   | `>>> foo()`               | primary + call                |
| 7   | `42`                      | result                        |
| 8   | `>>> exit()`              | primary + exit                |
| 9   | `$ `                      | local prompt                  |

## Checkpoints

| # | description                                              |
|---|----------------------------------------------------------|
| 1 | banner visible; primary prompt at row 3                  |
| 2 | prompt-shape assertion (`>>> ` on row 3)                 |
| 3 | continuation `... ` after `def foo():`                   |
| 4 | result row `42`; next primary prompt                     |
| 5 | `$ ` back after `exit()`; scrollback empty               |

## Files

| file | purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream |
| `checkpoints.json` | 5 checkpoints |
| `meta.json` | cols=60, rows=14, `kind='synthetic'`, `id='C-RP-01'`, `snapshotFormatVersion=1` |
| `build-fixture.mjs` | Generator script (idempotent) |

## Judgment call: trimmed banner

The real CPython banner on macOS is ~110 chars (`Python 3.11.5 (main,
Aug 24 2023, 15:09:45) [Clang 14.0.3 (clang-1403.0.22.14.1)] on
darwin`) plus a full help hint with four quoted keywords. At cols=60
that wraps across two rows and makes row-index assertions brittle.

We trim to a representative banner that fits in 60 cols while keeping
the `Python 3.11.5` version string intact (that's the load-bearing part
of CP 1). The wrap path is already covered by C-SH-02 and doesn't need
to be re-asserted here.

## Epic dependency

Green today.
