# C-ED-01: vim round-trip

**Status:** synthetic (hand-authored byte stream). Shipped wave 1
(Agent-C, green post Epic α at `f74c047`). A `tools/compat-record`
driven `recorded` variant is post-P0 work; see
`docs/plans/0005-sota-convergence/test-strategy.md` §4.2.

## What this fixture asserts

The critical behaviour of **DECSET 1049h / 1049l** (alt-screen swap):

1. Before 1049h, the main buffer holds the shell prompt and the `vim ...`
   command the user typed.
2. 1049h enters the alt buffer. The grid is cleared; `mode.alt_screen`
   flips to `true`.
3. vim paints its empty-buffer UI (tildes on blank lines, reverse-video
   status bar on the last row).
4. The user inserts `hello world` on alt-buffer row 0.
5. 1049l exits the alt buffer. **The main buffer must restore verbatim**
   — `hello world` MUST NOT be visible. Cursor returns to its pre-1049h
   position. `mode.alt_screen` flips back to `false`.
6. The shell reprints its prompt (`$ `) on the main buffer.

If step 5 fails (e.g. the emulator still shows alt-buffer content after
1049l), this test is the canary.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (147 bytes) |
| `checkpoints.json` | 6 checkpoints — cursor / mode / row projections at specific byte offsets |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real vim recordings depend on:

- The exact vim / nvim version in use.
- Terminfo capabilities the shell negotiated.
- Locale (UTF-8 vs CJK width tables).
- ~1 KiB of setup SGR that bloats the fixture with no added coverage.

A synthetic stream lets reviewers read every byte of the scenario (see
`build-fixture.mjs`) and still exercises the same emulator code paths
that matter: DECSET 1049, CSI cursor-move, CSI erase, SGR inverse.

## Epic dependency

Green post Plan 0005 Epic α (alt-buffer swap landed in `VtEmulator` at
commit `f74c047`). The integration test at
`packages/ui/src/__tests__/compat/C-ED-01-vim-round-trip.test.ts` runs
as a regular `it(...)`; no `.fails(...)` stamps.
