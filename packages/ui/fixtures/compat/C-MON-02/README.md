# C-MON-02: htop session with alt-screen exit

**Status:** synthetic (hand-authored byte stream). Will be replaced by a
real `htop` recording once `tools/compat-record` lands (Plan 0005 Epic
e6).

## What this fixture asserts

Like C-MON-01 (top) but stresses **coloured** alt-buffer repainting:

1. **CPU bar colour** (row 0): SGR 42 (named bg green) for "used" cells,
   SGR 43 (named bg yellow) for "user" cells. Stable across frames so
   `sgrDigest` pins the layout.
2. **Process state column** (rows 4-8): one-cell state column painted
   with SGR 32 (green) for running, SGR 0 (default) for sleeping, SGR 31
   (red) for zombie. Per-row `sgrDigest` catches any state-classification
   regression.
3. **Function-key footer** (row ROWS-1): `F1Help F2Setup ... F10Quit`.
4. **Scrollback invariant**: across all 3 repaint frames, the
   main-buffer scrollback ring stays at `rowCount === 0`. Alt paints are
   ephemeral; regression here breaks block-export semantics.
5. **Clean round-trip**: DECSET 1049l restores the main buffer with
   `$ htop` visible on row 0.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~2.3 KiB) |
| `checkpoints.json` | 6 checkpoints — alt enter, CPU SGR digest, proc state digests, footer, scrollback, alt exit |
| `meta.json` | Rows/cols/description/authoredAt |
| `build-fixture.mjs` | Generator script (run `node build-fixture.mjs` to regenerate) |

## Why synthetic?

Real htop output is highly system-dependent (process list, CPU count,
memory size, locale, htop config file). A hand-authored stream with a
fixed process list + stable colour layout is far more reviewable and
deterministic, and still exercises every engine invariant the fixture
cares about.

## Epic dependency

Green post Plan 0005 Epic α2 (alt buffer) + α3 (scrollback ring) + SGR
state (named bg/fg colours). No pending markers.
