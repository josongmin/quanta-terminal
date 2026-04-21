# C-STRESS-03: DPR-change mid-session sanity

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

A real DPR (device-pixel-ratio) change — e.g. dragging the window
between a retina and non-retina display — MUST invalidate the
renderer's font atlas so glyphs re-rasterise at the new pixel density.
That concern is **renderer-local**, not emulator-level.

This fixture therefore asserts the complementary engine-side sanity:
`VtEmulator.feed` and grid projection are UNAFFECTED by a hypothetical
DPR change. Byte-for-byte, the fixture is a minimal `ls --color=auto`
transcript with a splash of SGR styling.

If C-STRESS-03 regresses, the bug is somewhere other than DPR. Real
DPR / atlas-invalidation testing lives in:

- `packages/ui/src/shared/ui/cell-renderer/__tests__/` (FontAtlas,
  Canvas2DBackend suites).

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw byte stream (~50 bytes) |
| `checkpoints.json` | 3 checkpoints — prompt, styled ls output, final prompt |
| `meta.json` | cols=40, rows=10 |
| `build-fixture.mjs` | Regenerator (`node build-fixture.mjs`) |
