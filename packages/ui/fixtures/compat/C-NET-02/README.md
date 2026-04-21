# C-NET-02: remote bash over ssh (`cd /etc; ls`)

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-T). A `kind: recorded` variant via
`tools/compat-record` is post-P0 work; see test-strategy.md §4.2.

## What this fixture asserts

1. **Multi-turn SSH session** — unlike C-NET-01 (one-shot), this
   fixture opens a full interactive remote shell and exercises two
   commands before `exit`.
2. **Remote MOTD + banner** render on the main buffer before the first
   remote prompt.
3. **Remote `user@host:` prompt shape** is byte-exact on every row it
   appears.
4. **cwd-via-prompt heuristic** — after `cd /etc`, the next prompt
   reads `user@host:/etc$ `, inferring the new working directory purely
   from prompt text. This is a HEURISTIC (no OSC 7 yet); **P1-SI will
   replace this with an authoritative OSC 7 read.**
5. **`ls` output includes `passwd`** — proves multi-entry directory
   listings land as a single row.
6. **`altScreen: false` throughout** — interactive bash never enters
   alt-screen unless a sub-program (vim, tmux, etc.) does.

## Scenario

| row | content                            |
|-----|------------------------------------|
| 0   | `$ ssh localhost`                  |
| 1   | `Last login: Sat Jan  1 12:34:00 2022 from 127.0.0.1` |
| 2   | `user@host:/home/user$ cd /etc`    |
| 3   | `user@host:/etc$ ls`               |
| 4   | `hosts  motd  passwd  resolv.conf  shadow` |
| 5   | `user@host:/etc$ exit`             |
| 6   | `$ `                               |

## Checkpoints

| # | description                                                      |
|---|------------------------------------------------------------------|
| 1 | remote MOTD + initial `user@host:/home/user$ ` prompt visible    |
| 2 | prompt-shape assertion (narrow row projection)                   |
| 3 | after `cd /etc`, prompt now reads `user@host:/etc$ `             |
| 4 | `ls` output row contains `passwd`                                |
| 5 | after `exit`, local `$ ` back; altScreen stayed false            |

## Files

| file | purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream |
| `checkpoints.json` | 5 checkpoints — MOTD, prompt shape, cwd update, ls output, exit |
| `meta.json` | cols=60, rows=12, `kind='synthetic'`, `id='C-NET-02'`, `snapshotFormatVersion=1` |
| `build-fixture.mjs` | Generator script (idempotent) |

## Epic dependency

Green today. **P1-SI** will upgrade CP 3 from prompt-match to an OSC 7
read once authoritative cwd reporting lands.
