# C-STRESS-02: cat 100mb.log (scrollback eviction)

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

15 000 rows of `line NNNNN` force the scrollback ring past its
10 000-row default cap. At peak:

- `scrollback.rowCount === 10 000` (cap enforced),
- the ring did evict (empirically `evictedCount ≈ 4 978`).

Any future regression that lets the ring grow unbounded would fail the
`rowCount` assertion.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~176 KiB) |
| `checkpoints.json` | 3 checkpoints — cap at peak, alt-false invariant, final prompt |
| `meta.json` | cols=80, rows=24 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |

## Why synthetic?

The scenario is trivially reproducible from any log file; a
deterministic `line NNNNN` generator gives us stable assertions
without needing a specific 100 MB corpus.
