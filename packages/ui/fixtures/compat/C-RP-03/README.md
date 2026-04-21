# C-RP-03: psql `SELECT 1` round-trip

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-T). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

1. **psql banner** on the first two rows.
2. **Idle `mydb=> ` prompt** — dbname-aware prompt form pinned byte-
   for-byte on every row it appears.
3. **Result-table rendering** — column header, separator rule, result
   value, row count all land on consecutive rows.
4. **Clean `\q` exit** returns the local `$ ` prompt; altScreen stays
   false; scrollback ring stays empty.

## Scenario

| row | content                       |
|-----|-------------------------------|
| 0   | `$ psql mydb`                 |
| 1   | `psql (15.3)`                 |
| 2   | `Type "help" for help.`       |
| 3   | (blank)                       |
| 4   | `mydb=> SELECT 1;`            |
| 5   | ` ?column?`                   |
| 6   | `----------`                  |
| 7   | `        1`                   |
| 8   | `(1 row)`                     |
| 9   | (blank)                       |
| 10  | `mydb=> \q`                   |
| 11  | `$ `                          |

## Checkpoints

| # | description                                              |
|---|----------------------------------------------------------|
| 1 | psql banner + initial prompt at row 4                    |
| 2 | prompt-shape assertion (`mydb=> ` on row 4)              |
| 3 | result-table rows visible (header, rule, value, count)   |
| 4 | `$ ` back after `\q`; altScreen stayed false; scrollback empty |

## Files

| file | purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream |
| `checkpoints.json` | 4 checkpoints |
| `meta.json` | cols=40, rows=16, `kind='synthetic'`, `id='C-RP-03'`, `snapshotFormatVersion=1` |
| `build-fixture.mjs` | Generator script (idempotent) |

## Judgment call: prompt variants deferred

psql has three prompt shapes:
  - `dbname=> ` — idle
  - `dbname=* ` — inside an open transaction
  - `dbname-> ` — inside a multi-line statement

This fixture only exercises the idle form. The `=*`/`->` variants are
P1-upgrade candidates (exercise BEGIN...COMMIT + continued SELECT
statements). Documenting here so a future agent picks them up
intentionally.

## Judgment call: trimmed banner

Real psql emits version + platform + SSL negotiation + localisation
strings that vary wildly across versions. We ship a minimal two-line
banner (`psql (15.3)` + `Type "help" for help.`) — fixture
determinism beats field-level realism.

## Epic dependency

Green today.
