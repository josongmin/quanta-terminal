# EPIC-C — Glyph Instancing

- **Status**: Design-ahead. Freezes `CellInstance` VBO layout, shader pair, SGR → shader mapping, and cross-backend pixel-diff harness.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §13.11 (side-by-side diff), RFC 0001 §13.13 (perf budget decomposition), EPIC-D §4.3/§4.4 of RFC 0001 plan (Canvas2D Renderer + CellBuffer — read-only references), RFC 0002 §8 (instanced rendering), RFC 0002 §14 #2/#5/#6/#11/#13/#19.

---

## 1. Goal

Build the WebGL render path. VBO of cell instances, vertex + fragment shaders, SGR → shader bitfield mapping, truecolor resolution, per-frame damage-driven instance updates. End of this epic: `WebGLBackend` paints cells identical to `Canvas2DBackend` up to ±1 pixel across the entire RFC 0001 golden corpus, with all `backend-contract.test.ts` invariant cases green.

## 2. Phase

Phase C of RFC 0002 §17. Third in the dependency graph. Starts after EPIC-B exits (`FontAtlasGpu` public API frozen).

## 3. Duration

2 weeks.

## 4. Dependencies

- **EPIC-A exit**: contract surface frozen; `WebGLStubBackend` live.
- **EPIC-B exit**: `FontAtlasGpu.bindPage(pageId)` + `FontAtlasGpu.getOrRaster(key)` callable.
- **RFC 0001 EPIC-D**: `CellBuffer` (read-only) is the source of per-cell packed data we encode into instances.
- **RFC 0001 EPIC-C** (mirror): `GridMirror.Row` shape is the source of truth for cell state; read-only.

## 5. Scope

### 5.1 In

- `WebGLBackend` — promoted from stub to real paint implementation.
- VBO management: allocation, `bufferSubData` for damage, double-buffering if profile shows driver stalls.
- Shader pair (`vertex.glsl.ts` + `fragment.glsl.ts`) — GLSL ES 3.00 sources; compile + link at mount.
- `CellInstanceEncoder` — turns `CellBuffer` packed cells + atlas entries into `CellInstance` records.
- SGR attrs → `attrsBits` bitfield (bold / italic / underline / strike / faint / double-under / inverse).
- Truecolor path: resolve CPU-side (palette kinds 0/1/2/3) to RGBA, pack into instance.
- Damage-driven updates: only dirty rows' instances re-uploaded each frame.
- Background-fill pass (separate, simpler shader — no atlas sample).
- Resize handling: VBO resize + `u_viewportPx` uniform update + re-layout.
- Cross-backend pixel diff harness (golden corpus replay, ±1 px tolerance).
- SGR state-variant audit — assert `attrsVariant` fits in packing budget.
- Instanced draw-call count telemetry (budget: ≤ 3 per frame steady-state).

### 5.2 Out

- Cursor pass — EPIC-D.
- Selection overlay pass — EPIC-D.
- IME overlay pass — EPIC-D.
- Hyperlink hover underline — EPIC-D.
- Perf benches — EPIC-E (this epic has the perf harness hooks, not the budget enforcement).
- Rollout flag — EPIC-F.
- Context-loss handling — EPIC-F (though EPIC-C adds a placeholder `onContextLost?` that triggers a no-op; wire-up is F).

## 6. Files

All new unless marked `updated`.

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/WebGLBackend.ts` | **Updated** — full implementation. Stub behavior replaced with real paint. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/CellInstanceEncoder.ts` | Turns `CellBuffer` rows + atlas hits into instance records. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/VboManager.ts` | Instance VBO allocation + `bufferSubData` damage updates. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/ShaderProgram.ts` | Compiles + links vertex + fragment shaders; uniform + attribute location caching. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/vertex.cells.glsl.ts` | GLSL ES 3.00 vertex shader source as a TS string. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/fragment.cells.glsl.ts` | GLSL ES 3.00 fragment shader. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/vertex.background.glsl.ts` | Background-fill vertex shader. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/shaders/fragment.background.glsl.ts` | Background-fill fragment shader. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/SGREncoder.ts` | Maps `CellBuffer` attrs + colors → `CellInstance` fields. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/TruecolorResolver.ts` | Resolves palette8/256/truecolor kinds to RGBA. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/DrawCallBudget.ts` | Per-frame draw-call counter + assertion in dev. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/types.ts` | **Updated** — `CellInstance`, `UniformSet`, `DrawCallStats`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/WebGLBackend.test.ts` | Mount / applyGridSnapshot / applyGridDelta / unmount. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/CellInstanceEncoder.test.ts` | Per-cell packing. Wide chars produce one instance. SGR attrs packed correctly. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/VboManager.test.ts` | Alloc + subupload + resize. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/ShaderProgram.test.ts` | Compile + link + uniform lookups. Fail path on bad source. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/SGREncoder.test.ts` | All attrs combinations → correct bitfield. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/TruecolorResolver.test.ts` | palette8/256/truecolor → correct RGBA. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/DrawCallBudget.test.ts` | Budget counter logic. |
| `packages/ui/src/shared/ui/cell-renderer/__tests__/cross-backend-pixel-diff.test.ts` | Golden PTY stream replay → Canvas2D + WebGL pixel diff ≤ ±1. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/backend-contract.test.ts` | **Updated** — `WebGLBackend` (real) added to parity loop. |

## 7. Definition of Done

- [ ] `WebGLBackend.mount(ctx)` — acquires WebGL2 context, compiles shaders, allocates VBOs, runs atlas warmup, emits `backend.mount_ok{backend=webgl}`.
- [ ] `WebGLBackend.applyGridSnapshot(rows, cursor, mode)` — fresh encode of all cells into instance VBO, renders full frame on next `requestDamageFlush`.
- [ ] `WebGLBackend.applyGridDelta(rows, dirtyRows)` — dirty-row instance subupload only. Clean rows' VBO regions untouched.
- [ ] `WebGLBackend.applyCursor(cursor)` — no cell instance touched (EPIC-D owns cursor).
- [ ] `WebGLBackend.applyMode(mode)` — updates `u_bgBase` + cursor-shape hint. No atlas drop.
- [ ] `WebGLBackend.applyMetrics(metrics, dpr)` — uniform update; VBO resize if cell count changes.
- [ ] `WebGLBackend.requestDamageFlush()` — 2 draw calls (background + glyphs) per frame steady state; a 3rd if overlay is dirty (EPIC-D consumer).
- [ ] `WebGLBackend.measureText(text, attrsVariant)` — delegates to width SSOT + atlas measure; returns `{widthPx, cellsWide}` matching Canvas2D byte-for-byte.
- [ ] `WebGLBackend.screenToCell(x, y)` / `cellToScreen(row, col)` — same math as Canvas2D; tested for equality.
- [ ] `WebGLBackend.unmount()` — deletes VBO, shader program, atlas pages; container empty; no GL resources leak (mock counter).
- [ ] `CellInstance` layout frozen: 48 bytes, 16-byte-aligned. Layout documented at top of `types.ts` with byte offsets.
- [ ] Wide-char cells produce ONE instance with `cellsWide = 2`. Right-half cell is NOT a separate instance.
- [ ] `attrsBits` packs: bold (bit 0), italic (1), underline (2), strike (3), faint (4), double-under (5), inverse (6), reserved (7). Tested exhaustive.
- [ ] Truecolor resolver handles all 4 palette kinds from `CellBuffer` packing; output RGBA is premultiplied.
- [ ] Inverse attr resolves CPU-side (swap fg/bg in the instance record) — simpler than shader branch.
- [ ] `DrawCallBudget` asserts in dev: steady-state ≤ 3 draws/frame. Overage logs + telemetry.
- [ ] Resize: VBO re-allocates, `u_viewportPx` updates, no partial-state visible. Asserted in `resize-flow.e2e.test.tsx`-parallel test.
- [ ] Theme change: `u_bgBase` updates next frame; atlas untouched; pixels match Canvas2D under same theme.
- [ ] Cross-backend pixel diff: RFC 0001 compat golden corpus (vim, tmux, htop, less, nano, ranger, ssh loopback) replayed through Canvas2D + WebGL; diff ≤ ±1 per pixel on RGB, ±0 on selection-rect edges.
- [ ] `backend-contract.test.ts` invariants all green on real `WebGLBackend`.
- [ ] No new required method on `BackendContract`.
- [ ] Shader sources kept as TS string constants — no fetch, no build-time bundler tricks. CSP-safe.
- [ ] Shaders pass `glslang` validation at build time (pre-commit hook optional; CI required).
- [ ] `pnpm -F @quanta/ui test` green.
- [ ] `pnpm -F @quanta/ui lint` green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.

## 8. Quality gates

- **Coverage** ≥ 90 % on encoder / VBO / shader-program modules.
- **Pixel diff** — CI job fails PR on any cell > ±1 across golden corpus.
- **Draw-call budget** — dev-mode assertion; CI enforces via instrumented backend counter.
- **Shader validation** — `glslang` in CI catches bad GLSL before runtime.
- **TS strict** — zero `any`; `CellInstance` is a strongly typed struct.
- **No leak** — GL resource counter after unmount = 0.
- **Determinism** — same mirror snapshot → same pixel output (bit-for-bit) across runs on the same GPU.
- **No dependency on Canvas2D implementation** — import-graph test.
- **`webgl-mock`** (or a minimal hand-rolled mock) — unit tests do not require a real GPU. E2E tests may use real WebGL on the gated "real-gpu" lane.

## 9. E2E tests

1. `packages/ui/src/__tests__/e2e/webgl-mount-paint.e2e.test.tsx` — mount TerminalCanvas with `backend='webgl'`; feed a snapshot; pixels match Canvas2D ≤ ±1.
2. `packages/ui/src/__tests__/e2e/webgl-delta-paint.e2e.test.tsx` — feed snapshot + 50 deltas; pixel-diff per frame ≤ ±1; draw-call count ≤ 3 per frame.
3. `packages/ui/src/__tests__/e2e/webgl-resize.e2e.test.tsx` — resize mid-session; no partial-state frame; final pixels match Canvas2D.
4. `packages/ui/src/__tests__/e2e/webgl-truecolor.e2e.test.tsx` — feed cells with palette8/256/truecolor fg + bg; pixels match Canvas2D.
5. `packages/ui/src/__tests__/e2e/webgl-wide-char.e2e.test.tsx` — feed row with `한`, `👨‍👩‍👧‍👦`, `カ`; wide cells render as one instance; right-half is NOT a separate glyph; selection hit-test matches Canvas2D.
6. `packages/ui/src/__tests__/e2e/webgl-attrs-matrix.e2e.test.tsx` — every SGR attr combo rendered; pixel diff ≤ ±1 vs Canvas2D.
7. `packages/ui/src/__tests__/e2e/webgl-theme-swap.e2e.test.tsx` — swap theme; atlas unchanged; pixels match Canvas2D post-swap.
8. `packages/ui/src/__tests__/e2e/webgl-rapid-resize.e2e.test.tsx` — 50 rapid resize events; no partial-state frames; VBO integrity intact.

## 10. Unit tests

- `WebGLBackend.test.ts` — mount / unmount lifecycle, snapshot apply, delta apply, metrics apply.
- `CellInstanceEncoder.test.ts` — 40+ cases covering every SGR combination, wide chars, empty cells.
- `VboManager.test.ts` — alloc, subupload, resize, reset.
- `ShaderProgram.test.ts` — compile, link, uniform locations; intentional bad source paths.
- `SGREncoder.test.ts` — bitfield correctness for all attrs.
- `TruecolorResolver.test.ts` — palette8, palette256, truecolor, default; 20+ cases from RFC 0001 golden color matrix.
- `DrawCallBudget.test.ts` — counter increments, budget breach detection.
- `cross-backend-pixel-diff.test.ts` — golden corpus driver; enumerates replay scripts; produces a diff report.

## 11. Failure modes

- **Shader compile fail on Mesa/Intel driver** — `ShaderProgram.compile()` returns error string; `WebGLBackend.mount()` returns false; Renderer falls back to Canvas2D. Caught in EPIC-F; this epic logs + surfaces the error.
- **Atlas page binding stale after page drop** — `CellInstanceEncoder` checks page-id validity before encoding; triggers re-raster on stale.
- **Instance VBO too small for viewport** — `VboManager` grows geometrically on resize; shrink deferred.
- **`bufferSubData` with misaligned offset** — asserted in dev; aligned-write helper.
- **SGR attr combo not covered** — fail-safe: unknown attrs rendered without decoration; telemetry counter.
- **Truecolor packing loss** — 6-bit top approximation in `PackedCell` is an *approximation* for fast equality; full RGBA lives in `trueColorMap`; encoder reads from `trueColorMap` to avoid round-trip loss. Asserted.
- **Wide-char double-instance bug** — fail-safe: encoder skips right-half marker cells; test exhaustive.
- **Theme change mid-frame** — mitigation: `applyMode` updates uniforms, but damage tracking triggers full redraw next frame; no mid-frame uniform swap.
- **Rapid resize uniform drift** — `applyMetrics` updates `u_viewportPx` atomically; VBO grows if needed; asserted.
- **Draw call > 3 per frame** — dev assertion; CI fails if steady-state exceeds.
- **Shader source typos** — `glslang` validator in CI.
- **`gl.getError()` returns non-zero after a draw** — dev assertion; CI fails.
- **Inverse attr visible diff vs Canvas2D** — known to diverge if Canvas2D uses shader-style swap; encoder swaps fg/bg CPU-side for parity.
- **Faint attr visible diff** — faint is `alpha * 0.5` in both backends; asserted.
- **Strikethrough/underline pixel rows off-by-one** — stroke position derived from `baselineOffset` identically; CI pixel-diff catches.
- **Blink attr** — EPIC-D owns blink (overlay layer); cell pass leaves blink as a solid color; blink phase is cursor/overlay uniform.
- **Text aliasing difference** — both backends use same OffscreenCanvas rasterizer; atlas stores rasterized glyphs identically. Asserted.

## 12. Risks

- **Driver variance** — Mesa, Intel, AMD, NVIDIA each have GLSL quirks. Mitigation: test matrix in EPIC-E; fallback path in EPIC-F.
- **`webgl-mock` fidelity** — our unit tests' mock may miss real-driver bugs. Mitigation: e2e tests run on a gated real-GPU lane.
- **Shader hot-reload complexity** — not in v1; shaders compiled once on mount.
- **Pixel-diff flakiness** — sub-pixel rasterization differences. Mitigation: ±1 tolerance is generous; edge-case pixels documented in the diff report.
- **CellInstance packing changes post-freeze** — if v2 needs more attrs, the `reserved` slot absorbs one field; beyond that, VBO layout change is an RFC amendment.
- **`gl.vertexAttribDivisor` quirks on Mac M1** — tested early; if broken, instancing fallback path (per-cell draw calls) is NOT implemented in v1 — better to fall back to Canvas2D. Decision logged.

## 13. Rollback

- Revert EPIC-C commits; `WebGLBackend` returns to EPIC-A stub behavior.
- Shaders deleted.
- VBO + encoder deleted.
- Pixel-diff harness deleted.
- EPIC-D + EPIC-E blocked; RFC 0002 train paused.

Canvas2D + stub-only path remains unaffected. Production is Canvas2D throughout.

## 14. Cross-references

- **RFC 0002 §8** — canonical design; this epic implements.
- **RFC 0002 §13 (six-axis)** — axis 1 "Correctness parity" directly gated by this epic's pixel diff.
- **RFC 0002 §14 #2, #5, #6, #11, #13, #19** — owned failure modes.
- **RFC 0001 §13.11** — side-by-side diff; extended here with `backend=webgl` dimension.
- **RFC 0001 §13.13** — perf budget decomposition; this epic's draw-call budget + instance-upload cost feed the stage budgets.
- **EPIC-A §7** — contract surface already frozen.
- **EPIC-B §16** — atlas bind + raster path consumed here.
- **EPIC-D §6** — consumes `CellInstance` VBO layout for cursor + overlay passes.
- **EPIC-E §6** — consumes draw-call counter + frame-time instrumentation.
- **EPIC-F §8** — wires `onContextLost?` to `WebGLBackend.dispose()`.

## 15. Day-by-day breakdown

### Week 1

**Day 1** — Scaffolding + VBO manager
- `WebGLBackend.ts` promoted from stub; skeleton methods real.
- `VboManager.ts` alloc + subupload + resize.
- `VboManager.test.ts` green.

**Day 2** — Shader program
- Write `vertex.cells.glsl.ts` + `fragment.cells.glsl.ts`.
- `ShaderProgram.ts` compile + link + uniform cache.
- `ShaderProgram.test.ts` green.
- Add `glslang` CI step (validates shader sources).

**Day 3** — Instance encoder + SGR
- `CellInstanceEncoder.ts` reads `CellBuffer` packed cells, emits `CellInstance`.
- `SGREncoder.ts` bitfield mapping.
- `TruecolorResolver.ts` palette resolution.
- Unit tests for each green.

**Day 4** — Background-fill pass
- Separate shader pair.
- Separate small VBO.
- Integrated into `WebGLBackend.requestDamageFlush()`.

**Day 5** — First paint
- Mount → warmup atlas → paint snapshot → observe on a real canvas (dev harness).
- Compare by eye to Canvas2D on same mirror state.
- Fix obvious issues.

### Week 2

**Day 6** — Delta path
- Dirty-row `bufferSubData` works correctly.
- Clean rows untouched.
- Damage-coalesced per rAF.

**Day 7** — Wide chars + truecolor end-to-end
- Wide-char encoding verified.
- Truecolor palette kinds all paint correctly.
- Pixel-diff harness green on simple cases.

**Day 8** — Cross-backend pixel diff
- `cross-backend-pixel-diff.test.ts` driver built.
- Golden corpus replay from RFC 0001 compat.
- Initial diff report; fix outliers.

**Day 9** — Resize + theme + metrics
- All `applyMetrics` + `applyMode` paths covered.
- Rapid-resize test green.
- Theme swap test green.

**Day 10** — Draw-call budget + polish
- `DrawCallBudget` dev assertion live.
- `backend-contract.test.ts` runs against real `WebGLBackend`; all green.
- Memory leak on unmount verified.
- Pixel-diff ≤ ±1 across entire golden corpus.
- Tag `CellInstance` VBO layout frozen for EPIC-D + EPIC-E.

## 16. Cross-epic handoffs

- **To EPIC-D**: `CellInstance` layout + VBO binding protocol. EPIC-D adds cursor pass + overlay pass as additional draw calls using shared uniforms + its own small VBOs.
- **To EPIC-E**: frame-time, draw-call count, and instance-upload byte count are instrumented via `DrawCallBudget` + `WebGLBackend.reportDiagnostics?.()`; EPIC-E benches read these.
- **To EPIC-F**: shader compile failure surfaces via `WebGLBackend.mount()` return value; EPIC-F converts that into fallback activation.
