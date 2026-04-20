# EPIC-D — Selection / Cursor / IME Overlays

- **Status**: Design-ahead. Freezes the three-pass paint order + cursor shader + selection highlight shader + IME overlay bridge + hyperlink hover stroke.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §10 (IME state machine), RFC 0001 §11 (selection / copy / search authority), RFC 0001 §13.8 (selection / copy acceptance), ADR 0016 (selection / search / copy semantics), ADR 0018 (IME state machine), EPIC-D §4.4–§4.7 of RFC 0001 plan (Canvas2D cursor + selection + IME overlay — parity reference), RFC 0002 §9 (overlay composition), RFC 0002 §14 #10/#12/#14.

---

## 1. Goal

Preserve the three-layer paint model (cells → cursor → overlay) on the GPU, byte-for-byte identical to Canvas2D in Z-order and alpha blending. Selection rectangles, cursor shapes + blink, IME preedit, hyperlink-hover underlines all render as separate draw passes on top of the cells pass delivered by EPIC-C. No change to `Selection.ts`, `HitTest.ts`, `Search.ts`, or the IME state machine (ADR 0018) — this epic only adds the paint calls.

## 2. Phase

Phase D of RFC 0002 §17. Starts after EPIC-C exits (`CellInstance` VBO layout frozen, cells pass producing pixel-parity frames).

## 3. Duration

1 week.

## 4. Dependencies

- **EPIC-A exit**: contract surface frozen.
- **EPIC-B exit**: atlas can rasterize ad-hoc IME preedit strings via `FontAtlasGpu.getOrRaster`.
- **EPIC-C exit**: cells pass painting correctly; `CellInstance` VBO layout frozen; `u_viewportPx` + `u_cellSizePx` uniforms live.
- **RFC 0001 EPIC-D**: Canvas2D cursor + selection + IME overlay = parity reference.
- **RFC 0001 EPIC-E**: IME state machine (ADR 0018) + `PreeditOverlay` consumer contract — read-only.
- **`Selection.ts`, `HitTest.ts`, `Search.ts`** — untouched; read their public API only.

## 5. Scope

### 5.1 In

- Cursor pass: block / bar / underline shapes; blink driven by `performance.now() % 1000` phase; single instance (or two for wide-char cursor).
- Selection pass: rectangle-per-run, alpha-blended over fg; multi-line selection runs enumerated by `Selection.getHighlightRects()`.
- Hyperlink hover pass: 1-px underline stroke on hovered hyperlink range.
- IME preedit overlay: rasterized to atlas (small dedicated attrsVariant bit), drawn via shared glyph shader with `u_overlay = 1` uniform suppressing background.
- Z-order + blending preserved: cells → cursor → overlay; premultiplied alpha.
- Cursor blink synchronization with Canvas2D (derived from the same `performance.now` phase computation).
- Draw-call budget: cells pass = 2 (bg + glyphs), cursor pass = 1, overlay pass = 1 (merged selection + hyperlink + IME). Total ≤ 4 per frame.
- Parity tests: selection, cursor, IME overlay, hyperlink hover — all match Canvas2D pixel-for-pixel ≤ ±1.

### 5.2 Out

- Any change to `Selection.ts`, `HitTest.ts`, `Search.ts` — never.
- IME state machine — ADR 0018 shipped in RFC 0001.
- Clipboard operations — feature-module concern, unchanged.
- Cursor keybindings — input feature concern, unchanged.
- Perf benches — EPIC-E.
- Rollout flag — EPIC-F.

## 6. Files

All new unless marked `updated`.

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/CursorPass.ts` | Cursor draw call. Reads current cursor state, emits 1–2 instances into a small cursor VBO, draws with a cursor-specific shader. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/SelectionPass.ts` | Selection highlight pass. Reads `Selection.getHighlightRects()`, draws rectangle instances with alpha blending. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/OverlayPass.ts` | Merged selection + hyperlink-hover + IME pass driver. Orchestrates `SelectionPass`, `HyperlinkHoverPass`, `IMEOverlayPass`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/HyperlinkHoverPass.ts` | 1-px underline stroke over hovered hyperlink range. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/IMEOverlayPass.ts` | Draws IME preedit text. Reuses glyph atlas + cells shader with overlay uniform. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/vertex.cursor.glsl.ts` | Cursor vertex shader. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/fragment.cursor.glsl.ts` | Cursor fragment shader (block/bar/underline branches). |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/vertex.selection.glsl.ts` | Selection shader (simple rectangles). |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/fragment.selection.glsl.ts` | Selection fragment shader (solid color + alpha). |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/WebGLBackend.ts` | **Updated** — `requestDamageFlush` now orchestrates 3 passes. `mountOverlay` / `updateOverlay` / `unmountOverlay` wire through `IMEOverlayPass`. `applyCursor` triggers cursor-pass mark-dirty. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/types.ts` | **Updated** — `CursorInstance`, `SelectionInstance`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/CursorPass.test.ts` | Unit: cursor shape branches, blink phase math, wide-char cursor. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/SelectionPass.test.ts` | Unit: rect enumeration, multi-line runs, empty selection. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/HyperlinkHoverPass.test.ts` | Unit: stroke path, hover state updates. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/IMEOverlayPass.test.ts` | Unit: mount / update / unmount overlay; idempotence. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/OverlayPass.test.ts` | Unit: merged draw orchestration; z-order; blend state. |
| `packages/ui/src/shared/ui/cell-renderer/__tests__/overlay-pixel-diff.test.ts` | Cross-backend pixel diff on overlay scenarios. |

## 7. Definition of Done

- [ ] `CursorPass` draws block / bar / underline via shader branch on `u_cursorShape`; shape read from `TerminalModeState`.
- [ ] Cursor blink phase derived from `performance.now() % 1000` identically to Canvas2D (shared helper `shared/ui/cell-renderer/cursor-blink-phase.ts` — or inline if no sharing possible without modifying Canvas2D; in that case, duplicate math with a parity test asserting equality).
- [ ] Wide-char cursor renders at 2-cell width; right edge aligned to cell grid.
- [ ] Cursor hidden correctly when `cursor.visible === false`; cursor drawn as hollow outline when terminal is unfocused (matches Canvas2D).
- [ ] `SelectionPass` reads `Selection.getHighlightRects()` — no internal selection math; backend is a dumb renderer.
- [ ] Selection rectangles alpha-blend at 0.3 over fg color; color driven by `u_selectionColor` uniform (theme-dependent).
- [ ] Multi-line selection: each logical run is one instance; no per-cell instances.
- [ ] Selection across continuation rows honors the wrap-joined semantics from `Selection.ts` — backend does not know, just paints what `getHighlightRects` returns.
- [ ] `HyperlinkHoverPass` draws a 1-px underline stroke in the hyperlink hover color; triggers on pointer-hover events surfaced to `TerminalCanvas`.
- [ ] `IMEOverlayPass` mount / update / unmount: `mountOverlay` rasters preedit text via `FontAtlasGpu.getOrRaster` with a unique `attrsVariant` bit; draws via cells shader with `u_overlay = 1` uniform.
- [ ] Overlay handles are symbols; idempotent unmount; no GL resource leak.
- [ ] IME overlay Z above cursor, below block chrome — per RFC 0001 §10.2.
- [ ] IME overlay survives focus loss gracefully (unmount request from consumer — not backend concern).
- [ ] `WebGLBackend.requestDamageFlush()` orchestrates passes in order: background (cells EPIC-C) → glyphs (cells EPIC-C) → cursor → overlay (selection + hyperlink + IME).
- [ ] Draw-call count steady-state ≤ 4. Dev assertion via `DrawCallBudget` (EPIC-C infrastructure).
- [ ] Blend state: premultiplied alpha; `gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`; reset between passes as needed.
- [ ] `overlay-pixel-diff.test.ts` green: Canvas2D + WebGL both render identical pixels ≤ ±1 for selection, cursor, IME, hyperlink-hover scenarios.
- [ ] Z-order invariant: cells < cursor < overlay. Asserted via deliberate overlapping test.
- [ ] `mountOverlay` / `updateOverlay` / `unmountOverlay` methods on `WebGLBackend` delegate to `IMEOverlayPass`; no direct DOM mutation.
- [ ] No modification to `Selection.ts`, `HitTest.ts`, `Search.ts`. Import-graph asserts.
- [ ] Parity tests: `selection.test.ts` + `copy-normalization.test.ts` + `hyperlink-click.test.ts` + `ime-overlay.test.ts` (EPIC-D §3.1 of RFC 0001 plan) all run against WebGL backend — all green.
- [ ] `backend-contract.test.ts` overlay / cursor invariants still green.
- [ ] No new required method on `BackendContract`. `mountOverlay` / `updateOverlay` / `unmountOverlay` already exist.
- [ ] `pnpm -F @quanta/ui test` green.
- [ ] `pnpm -F @quanta/ui lint` green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.

## 8. Quality gates

- **Coverage** ≥ 90 % on each Pass module.
- **Pixel diff** — overlay-pixel-diff harness fails PR on any diff > ±1.
- **Z-order regression** — deliberate-overlap test catches any reorder.
- **Blend-state regression** — explicit assertion on `gl.getParameter(BLEND_SRC_RGB)` after each pass.
- **Leak** — overlay handle count after `unmountOverlay` = 0.
- **Blink-phase parity** — shared helper OR duplicated math + assertion test.
- **No access to selection internals** — `SelectionPass` only calls public `Selection.getHighlightRects()`. Grep rule.
- **Import-graph** — `backend/webgl/**` does not import from `cell-renderer/Selection.ts` or `HitTest.ts` or `Search.ts`. Only `getHighlightRects` via public interface; this ends up as a `cell-renderer/types.ts` shared type import — no code import.

## 9. E2E tests

1. `packages/ui/src/__tests__/e2e/webgl-cursor-shapes.e2e.test.tsx` — cycle cursor shape (block / bar / underline); assert pixel diff ≤ ±1 vs Canvas2D.
2. `packages/ui/src/__tests__/e2e/webgl-cursor-blink.e2e.test.tsx` — observe cursor over 2 seconds at 60 fps; assert blink phase matches Canvas2D within 1 frame tolerance.
3. `packages/ui/src/__tests__/e2e/webgl-selection-multiline.e2e.test.tsx` — drag-select across 3 wrapped rows; assert highlight rect count = logical runs, pixel diff ≤ ±1 vs Canvas2D.
4. `packages/ui/src/__tests__/e2e/webgl-ime-lifecycle.e2e.test.tsx` — mount preedit overlay, update text 5×, unmount; assert no leak; pixel diff ≤ ±1 vs Canvas2D.
5. `packages/ui/src/__tests__/e2e/webgl-hyperlink-hover.e2e.test.tsx` — hover over OSC 8 hyperlink range; underline stroke appears; unhover → stroke removed; pixel diff ≤ ±1 vs Canvas2D.
6. `packages/ui/src/__tests__/e2e/webgl-z-order.e2e.test.tsx` — deliberately overlap cursor + selection + IME at same cell; assert final pixel order cells < cursor < overlay.
7. `packages/ui/src/__tests__/e2e/webgl-wide-char-cursor.e2e.test.tsx` — cursor on a 2-cell CJK; asserts 2-cell-wide rendering.

## 10. Unit tests

- `CursorPass.test.ts` — 15+ cases: each shape, visible/invisible, focused/unfocused, wide-char.
- `SelectionPass.test.ts` — 15+ cases: single-line, multi-line, wrap-continuing, empty, full-screen.
- `HyperlinkHoverPass.test.ts` — 10+ cases: hover in/out, multi-line link, no link, stroke position.
- `IMEOverlayPass.test.ts` — 10+ cases: mount / update / unmount / re-mount, concurrent handles, rapid update.
- `OverlayPass.test.ts` — 10+ cases: pass ordering, blend state resets, dirty-flag coalescing.

## 11. Failure modes

- **Cursor blink desync with Canvas2D** — shared helper or asserted equality.
- **Selection rect off-by-one at wide-char boundary** — `getHighlightRects` is authoritative; backend does not re-measure. Tested.
- **Hyperlink hover flickers on rapid pointer move** — debounced by `TerminalCanvas` owning the hover state; backend passes through.
- **IME overlay handle leak on rapid mount/unmount** — idempotent unmount + counter test.
- **Z-order violation on overlay pass** — deliberate-overlap test.
- **Blend state left in wrong mode between passes** — explicit reset + parameter assertion.
- **Selection color wrong under theme swap** — `u_selectionColor` uniform updates on theme change via `applyMode`.
- **Cursor color wrong** — `u_cursorColor` updates similarly.
- **Wide-char cursor covers only 1 cell** — cells-wide attribute on cursor instance; tested.
- **IME overlay text wider than available cells** — layout rule: overlay extends beyond terminal right edge as an absolutely-positioned-like float; RFC 0001 EPIC-E already handles the layout math; backend just renders.
- **Overlay VBO not resized on row change** — EPIC-C VBO policy reused.
- **Concurrent overlay mounts from rapid composition events** — `IMEOverlayPass` tracks all active handles in a Map; all drawn each frame.
- **Hover stroke Y misalignment** — stroke position derived from `baselineOffset + descent`; identical to Canvas2D; asserted.
- **Selection alpha wrong over truecolor bg** — premultiplied blend; pixel diff catches.
- **Cursor hidden when it should be visible** — lifecycle traces logged; telemetry counter for cursor-visible transitions.
- **IME preedit text caching atlas miss-storm** — each composition event potentially produces new glyphs; CPU fast path (EPIC-B) handles.
- **Selection across alt-screen transition** — Selection.ts handles clearing on buffer swap; backend just paints what it sees.
- **Draw-call count exceeds 4** — budget assertion trips dev.

## 12. Risks

- **Blink phase divergence** — the trickiest parity test; subtle floating-point differences between backends possible. Mitigated by shared helper.
- **Alpha blending on theme-transparent cells** — edge case; tested.
- **IME overlay cell-width miscalculation in preedit** — the preedit is its own rasterized atlas entry; width from atlas, not cells-wide SSOT (preedit is paint-layer, not grid). RFC 0001 §10 confirms.
- **Overlay passes sharing VBO with cells pass** — not planned; each pass has its own small VBO. Isolation is the point.
- **Cursor + IME overlap rendering order** — RFC 0001 §10.2 specifies preedit above cursor.

## 13. Rollback

- Revert EPIC-D commits.
- WebGL cells pass (EPIC-C) survives but cursor + overlays are no-op.
- Canvas2D + production unaffected.
- EPIC-E + EPIC-F blocked.

## 14. Cross-references

- **RFC 0002 §9** — canonical three-pass design.
- **RFC 0002 §14 #10, #12, #14** — owned failure modes.
- **RFC 0001 §10.2** — preedit Z-order rule.
- **RFC 0001 §11** — selection authority; backend consumes, does not own.
- **RFC 0001 §13.8** — selection / copy acceptance; parity tests extend.
- **ADR 0016** — selection / search / copy — semantic contract, read-only.
- **ADR 0018** — IME state machine — consumer side, read-only.
- **EPIC-C §6** — CellInstance + uniforms + cells shader reused.
- **EPIC-B §16** — `FontAtlasGpu.getOrRaster` used for IME preedit rasterization.
- **EPIC-A §7** — contract surface frozen.

## 15. Day-by-day breakdown

### Day 1 — Cursor pass
- `CursorPass.ts` + shaders.
- `CursorPass.test.ts` green.
- Blink phase helper decision (shared or duplicate); parity test.

### Day 2 — Selection pass
- `SelectionPass.ts` + shaders (solid-color rect pipeline).
- `SelectionPass.test.ts` green.
- Integrate into `WebGLBackend.requestDamageFlush()`.

### Day 3 — Hyperlink hover + IME overlay
- `HyperlinkHoverPass.ts` (reuses selection shader).
- `IMEOverlayPass.ts` (reuses cells shader with overlay uniform).
- Tests for each green.

### Day 4 — OverlayPass orchestrator
- `OverlayPass.ts` merges selection + hyperlink + IME into one logical pass.
- Z-order + blend-state resets.
- `OverlayPass.test.ts` green.

### Day 5 — Parity
- `overlay-pixel-diff.test.ts` green on: selection-multi-line, cursor shapes × blink, IME mount/update/unmount, hyperlink hover.
- Address outliers.

### Day 6 — Integration + wide-char
- Wide-char cursor test.
- Z-order overlap test.
- Integration with `TerminalCanvas` hover state.
- Draw-call count ≤ 4 steady-state assertion.

### Day 7 — Wrap
- All parity tests green across Canvas2D + WebGL.
- `backend-contract.test.ts` invariants green.
- Tag overlay passes frozen for EPIC-E benches.

## 16. Cross-epic handoffs

- **To EPIC-E**: overlay passes contribute to frame budget; EPIC-E benches measure cursor + overlay stage times separately (RFC 0002 §12).
- **To EPIC-F**: overlay handles survive context loss restore — EPIC-F re-mounts WebGL after context restore calls `applyGridSnapshot`, then consumers re-mount overlays; no backend state carried across.
