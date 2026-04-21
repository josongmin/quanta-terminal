# C-PG-03 — `more /etc/hosts`

**Status:** synthetic (hand-authored byte stream). Shipped at commit
`f74c047` (wave 4, Agent-W).

Companion to C-PG-01 (less, alt-buffer pager). This fixture exercises the
**opposite** pager contract: GNU `more` from util-linux paints content
directly into the main buffer and does **not** toggle DECSET 1049.

| Axis                | C-PG-01 (less)                | C-PG-03 (more)              |
| ------------------- | ----------------------------- | --------------------------- |
| Alt-buffer cycle    | Yes (DECSET 1049h / 1049l)    | No                          |
| `mode.altScreen`    | Toggles true, then false      | Stays false                 |
| Status row          | `:` / `(END)` reverse-video   | `--More--(NN%)` reverse-video |
| Scrollback impact   | None (alt-only)               | Main-buffer scroll captures |
| Exit primitive      | DECSET 1049l                  | CR + CSI K                  |

## Byte stream

1. `$ more /etc/hosts\r\n`.
2. 18 lines of hosts content printed with CRLF (no DECSET 1049).
3. Reverse-video `--More--(END)` prompt on the row below the content.
4. User presses `q` → CR + CSI K clears the prompt; shell reprints `$ `.

## Load-bearing assertions

- **CP 1**: `mode.altScreen: false` — the all-important anti-alt check.
- **CP 2**: `sgrDigest` on the `--More--(END)` row pins SGR 7 (inverse).
- **CP 3**: post-exit prompt lands cleanly; altScreen still false.
- **CP 4**: `scrollback.rowCount === 0` — the scenario fits on one
  screen so nothing evicts. (Contrast with C-MON-01's long warmup
  segment that positively asserts eviction content.)

## Regeneration

```
node packages/ui/fixtures/compat/C-PG-03/build-fixture.mjs
```
