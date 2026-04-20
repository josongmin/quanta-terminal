# EPIC-B — Font Atlas on GPU

- **Status**: Design-ahead. Freezes `FontAtlasGpu` public API + page allocator + LRU + invalidation + CPU-raster fast path.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §14.1 (SHOULD renderer items — glyph atlas, damage-based redraw), RFC 0001 §22 #19 (web-font late load), EPIC-D §4.2 of RFC 0001 plan (Canvas2D `FontAtlas` — the reference we preserve parity with), RFC 0002 §7 (GPU atlas design), RFC 0002 §14 #3/#4/#8/#15/#17/#18.
- **Spawns**: ADR 0020 draft (`docs/adr/0020-gpu-atlas-eviction.md`), scoped to page-eviction + per-entry LRU + cap numbers. Accepted in EPIC-F.

---

## 1. Goal

Build the GPU glyph atlas. Texture pages, per-entry LRU, whole-page eviction, DPR/theme/font-family/font-load invalidation, plus the CPU-raster fast path that prevents frame drops when a rasterization takes longer than the frame budget. The atlas is the long pole for the GPU backend's raster stage; EPIC-C assumes this API is frozen before VBO encoders are written.

## 2. Phase

Phase B of RFC 0002 §17. Second in the dependency graph. Starts only after EPIC-A exits (contract surface frozen + `WebGLStubBackend` parity green).

## 3. Duration

1.5 weeks.

## 4. Dependencies

- **EPIC-A exit**: `BackendContract.ts` has `warmupAtlas?` hook; `BackendDiagnostics` type exists; `WebGLStubBackend` is live.
- **RFC 0001 EPIC-D**: Canvas2D `FontAtlas` implementation is the parity reference. Read-only consumption.
- **`packages/ui/src/shared/lib/width-mirror/`** (TS width SSOT): atlas consumes `cellsWide` from here, does **not** measure width itself. Untouched; reference only.

## 5. Scope

### 5.1 In

- `FontAtlasGpu` class: public API + page allocator + LRU + invalidation + diagnostics.
- Texture page abstraction: desktop 2048 × 2048, mobile 1024 × 1024, floor 512 × 512.
- Per-entry LRU with hard cap 4 096 per page.
- Page eviction: drop coldest full page when all pages > 95 % full.
- Invalidation triggers: DPR change, theme change, font-family change, `document.fonts.ready` new face.
- CPU-raster fast path for slow graphemes (> 4 ms raster → Canvas2D-draw this cell, schedule GPU raster next idle).
- Warmup set: ASCII printable × {regular, bold, italic} pre-rasterized on mount.
- Diagnostics: expose `atlasEntries`, `atlasPages`, `atlasPageDropsLifetime`, `atlasMissCountLifetime`, `cpuFastPathHitsLifetime`.
- Unit + stress + bench tests.
- Draft ADR 0020 (atlas eviction policy). Proposed; accepted in EPIC-F.

### 5.2 Out

- GPU shader code — EPIC-C (though atlas provides the sampler resources).
- VBO / instance encoding — EPIC-C.
- `experimental.renderer` wiring — EPIC-F.
- Any change to the Canvas2D `FontAtlas` — never. Read-only reference.
- Rust / crate changes — never.
- Mirror / Selection / HitTest / Search — never.
- Shader compile / link — minimally, only for upload testing; full shader pipeline lives in EPIC-C.

## 6. Files

All new unless marked `updated`.

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/FontAtlasGpu.ts` | Main class. Public API matches Canvas2D `FontAtlas` where sensible; adds page + diagnostic methods. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/AtlasPage.ts` | One GL texture + a bin-packing allocator + per-rect LRU linked list. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/AtlasRasterizer.ts` | OffscreenCanvas 2D rasterizer. Produces `ImageBitmap` / `ImageData` slices for `texSubImage2D`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/AtlasInvalidation.ts` | Subscribes to DPR / font / theme events; emits `invalidateAll(reason)`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/AtlasWarmup.ts` | Pre-raster set definition + warmup driver. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/AtlasCpuFastPath.ts` | Fallback Canvas2D rasterizer used inline when GPU raster > 4 ms. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/types.ts` | GPU-atlas-specific types (`AtlasPageId`, `AtlasHandle`, `PageAllocResult`, `GpuAtlasKey`, `GpuAtlasEntry`, `InvalidationReasonGpu`). |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/index.ts` | **Updated** — export atlas barrel. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/FontAtlasGpu.test.ts` | Unit: getOrRaster, LRU eviction, page allocation, invalidation, warmup. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/AtlasPage.test.ts` | Unit: bin-packing, rect allocation, capacity. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/AtlasInvalidation.test.ts` | Unit: DPR event → invalidateAll, font-load → invalidateAll, theme change → NO invalidateAll (§10 RFC 0002). |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/AtlasCpuFastPath.test.ts` | Unit: slow-raster detection; fallback path rendering. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/AtlasWarmup.test.ts` | Unit: warmup fires on mount; idempotent. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/FontAtlasGpu.stress.test.ts` | Stress: 500-cell burst with 100 % miss; atlas capacity stress. |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-hit.bench.ts` | Bench: atlas-hit raster cost. |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-miss.bench.ts` | Bench: atlas-miss raster cost. |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-miss-recovery.bench.ts` | Bench: miss-storm recovery. |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-rebuild.bench.ts` | Bench: full rebuild (DPR change). |
| `docs/adr/0020-gpu-atlas-eviction.md` | New — draft, Proposed. |

## 7. Definition of Done

- [ ] `FontAtlasGpu.getOrRaster(key)` returns a valid `GpuAtlasEntry` with `pageId`, `u`, `v`, `w`, `h`, `cellsWide`, `ascent`, `descent`, `lastAccessTick`. Hit < 50 µs, miss < 3.5 ms.
- [ ] Page allocator allocates pages up to `MAX_PAGES = 4`; each page size is 2048 × 2048 (desktop default), 1024 × 1024 (mobile) — chosen by `MountContext.dpr` + feature detect.
- [ ] Bin-packing for rect allocation inside a page uses a simple row-shelf algorithm; benchmarked at < 100 µs per allocation.
- [ ] LRU linked list per page; `lastAccessTick` updated on `getOrRaster` hit. Eviction on capacity → `O(1)` via intrusive list head.
- [ ] Page eviction (§7.4 RFC 0002): when ALL pages > 95 % full, drop coldest entire page (GL texture released), allocate replacement. Drop frequency telemetry counter.
- [ ] DPR change (via `window.matchMedia('(resolution: 1dppx)').addEventListener` + ResizeObserver fallback) → `invalidateAll('dpr_change')`. All pages dropped; warmup re-runs on next `requestDamageFlush`.
- [ ] Font-family change (via user-settings observer) → `invalidateAll('font_family_change')`.
- [ ] `document.fonts.ready` resolves with a newly-loaded face that matches the active font → `invalidateAll('font_load_complete')`.
- [ ] Theme change → **no atlas invalidation** (GPU atlas renders uncolored; shader multiplies). Assertion in `AtlasInvalidation.test.ts`.
- [ ] CPU fast path: if GPU raster exceeds 4 ms (measured on `performance.now()` around rasterize), return a Canvas2D-rasterized fallback for THIS cell this frame; schedule GPU raster on next idle callback. Fast path never blocks.
- [ ] Warmup set (ASCII printable × {regular, bold, italic} = 94 × 3 = 282 glyphs) pre-rasterized on `mount()`. Total warmup < 0.5 ms on M-series baseline (bench).
- [ ] Diagnostics fields populated: `atlasEntries`, `atlasPages`, `atlasPageDropsLifetime`, `atlasMissCountLifetime`, `cpuFastPathHitsLifetime`. Exposed via `WebGLStubBackend.reportDiagnostics?.()` (update stub here).
- [ ] 500-cell miss burst (stress) does not drop a frame — verified by bench harness logging frame timestamps.
- [ ] Atlas capacity hard cap enforced: no unbounded growth. Telemetry on approach to cap.
- [ ] `atlas-miss-recovery.bench.ts` meets RFC 0002 §12 target 4.0 ms p95.
- [ ] `atlas-rebuild.bench.ts` meets RFC 0002 §12 target 18.0 ms p95.
- [ ] `raster-hit.bench.ts` meets target 0.4 ms p95.
- [ ] `raster-miss.bench.ts` meets target 3.5 ms p95.
- [ ] ADR 0020 draft complete: Title, Context, Decision (page size + cap + LRU + page-drop thresholds), Alternatives (global LRU vs per-page), Consequences, Open Questions.
- [ ] `WebGLStubBackend` unchanged in behavior: atlas is NOT invoked through stub (stub paint is no-op). Stub's `reportDiagnostics` still returns zeros.
- [ ] No required-method changes to `BackendContract`. Atlas lives inside the WebGL module.
- [ ] `pnpm -F @quanta/ui test` green.
- [ ] `pnpm -F @quanta/ui lint` green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.
- [ ] Benches runnable via `pnpm -F @quanta/ui bench:atlas` (new script); CI tag `@slow`.

## 8. Quality gates

- **Coverage** ≥ 95 % on `FontAtlasGpu` + `AtlasPage` + `AtlasInvalidation`.
- **Performance** — each bench enforces RFC 0002 §12 p95 target; CI fails PR on > 10 % regression.
- **Memory** — peak atlas VRAM bounded by `MAX_PAGES × page_size² × 4 bytes` = 4 × 2048 × 2048 × 4 = 64 MB hard; typical < 16 MB.
- **Leak** — unmount + remount releases all GL textures (asserted via `getAttachedTextures()` helper + mock counter).
- **No WebGL types outside `backend/webgl/`** — CI grep rule.
- **TS strict** — all atlas types non-null; no `any`.
- **No dependency on Canvas2D `FontAtlas`** — GPU atlas is a standalone class. Import-graph test asserts.
- **`AtlasInvalidation` must not fire in a microtask loop** — debounce ≥ 1 frame; asserted.

## 9. E2E tests

1. `packages/ui/src/__tests__/e2e/atlas-warmup.e2e.test.tsx` — mount WebGL-enabled TerminalCanvas (using `WebGLStub` extended with `FontAtlasGpu` for this epic — a TEST-ONLY subclass `WebGLAtlasOnlyBackend`); assert `atlasEntries ≥ 282` after mount.
2. `packages/ui/src/__tests__/e2e/atlas-dpr-change.e2e.test.tsx` — drive DPR change via jsdom + matchMedia shim; assert `atlasEntries` drops to 0, then rebuilds on next frame.
3. `packages/ui/src/__tests__/e2e/atlas-font-load.e2e.test.tsx` — drive `document.fonts.ready` resolution; assert `invalidateAll('font_load_complete')` fires; atlas rebuilds.
4. `packages/ui/src/__tests__/e2e/atlas-theme-no-invalidate.e2e.test.tsx` — drive theme change; assert `atlasEntries` **unchanged**; shader receives new uniform.
5. `packages/ui/src/__tests__/e2e/atlas-miss-burst.e2e.test.tsx` — feed snapshot with 500 unique graphemes; assert no frame > 20 ms; fast-path hits ≥ expected for slow graphemes.
6. `packages/ui/src/__tests__/e2e/atlas-page-drop.e2e.test.tsx` — feed snapshots filling 4 pages; assert page drop triggers; `atlasPageDropsLifetime ≥ 1`.
7. `packages/ui/src/__tests__/e2e/atlas-cpu-fast-path.e2e.test.tsx` — inject a synthetic slow rasterizer (5 ms); assert cell renders via CPU path this frame; GPU raster completes next idle.

## 10. Unit tests

- `FontAtlasGpu.test.ts` — 40+ cases:
  - getOrRaster hit + miss
  - LRU ordering
  - capacity overflow → eviction
  - page overflow → new page allocation
  - 4-page overflow → page drop
  - invalidation resets state
  - diagnostics fields update correctly
  - dispose() releases all textures
- `AtlasPage.test.ts` — 20+ cases: bin-packing corner cases, full-page detection, rect allocation failure recovery.
- `AtlasInvalidation.test.ts` — 15+ cases: each reason fires correctly, theme change does NOT fire, rapid DPR toggles debounced.
- `AtlasCpuFastPath.test.ts` — 10+ cases: slow raster triggers fallback, idle callback schedules GPU raster, fallback result matches GPU result ±1 px (same rasterizer code path, Canvas2D).
- `AtlasWarmup.test.ts` — warmup count, idempotence, cost bounded.
- `FontAtlasGpu.stress.test.ts` — 500 miss burst, 10k rotation, page-cycle stress.

## 11. Failure modes

- **Atlas eviction mid-burst drops a frame.** Mitigation: CPU fast path (§10 DoD). Stress test asserts.
- **Page drop causes glyph flicker** because a cell's entry was on the dropped page and re-rasters synchronously. Mitigation: drop coldest page only when no entry's rect is referenced by current frame's instance buffer; EPIC-C coordinates frame coherence.
- **DPR change storm (plug/unplug monitor rapidly)** — each change triggers `invalidateAll`. Mitigation: debounce ≥ 1 frame; CPU fast path covers the gap.
- **Font-load fires mid-paint** — mitigation: invalidation runs between `requestDamageFlush` calls, never mid-frame (RFC 0002 §10). `AtlasInvalidation` buffers until next rAF boundary.
- **Mobile Safari `OffscreenCanvas` unavailable** — mitigation: fallback to in-DOM `<canvas>` with `display: none`; rasterizer abstracted behind interface.
- **`texSubImage2D` throws on invalid page** (unlikely with our bin-packer) — caught, logged, atlas invalidates, CPU path covers the frame.
- **Shader sampler2DArray layer > MAX_ARRAY_TEXTURE_LAYERS** — capped at detection time (EPIC-F feature detect); MAX_PAGES ≤ min(4, MAX_ARRAY_TEXTURE_LAYERS).
- **Warmup exceeds budget on cold start** — bench gates at 0.5 ms; failure → reduce warmup set to ASCII-only regular.
- **CPU fast-path rasterizer forks from GPU rasterizer and produces different glyphs** — mitigation: shared rasterizer module; only output target (CPU direct draw vs GPU upload) differs.
- **Integer overflow in `lastAccessTick`** — `tick` is monotonic per-frame; u32 holds 828 days at 60 fps. Not a realistic concern but asserted.
- **Atlas VRAM exceeds hard cap** — shouldn't happen under page-drop policy; assertion trips telemetry + forces Canvas2D fallback.
- **`InvalidationReason` misfires on VisibilityChange** — mitigation: tab backgrounding pauses rAF; atlas survives; no invalidation.
- **OffscreenCanvas taint (CORS)** — all rasters use in-process font; no external image URIs touch the atlas. Grep rule.
- **Bench harness false green** — CI compares bench against stored baseline; > 10 % regression fails.
- **Memory leak on unmount** — GL texture disposal counter mocked; test asserts.

## 12. Risks

- **Bin-packer fragmentation** — row-shelf is simple but can leave gaps; mitigation: accept ~85 % effective utilization; page drop covers.
- **`performance.now` resolution jitter** for fast-path detection — mitigation: 4 ms threshold is generous vs 16 ms frame; acceptable noise.
- **Mobile GPU VRAM pressure** — 1024 × 1024 pages × 4 = 4 MB per page, 4 pages = 16 MB; acceptable for modern mobile; mitigation fallback Canvas2D if feature detect fails.
- **`document.fonts.ready` resolves on initial load not new face** — known quirk across browsers; detection logic reads `FontFace` set deltas rather than `ready` alone. Tested in `AtlasInvalidation.test.ts`.
- **Canvas2D FontAtlas behavior drift** — we parity-test against it; if RFC 0001 side-by-side diff catches divergence, EPIC-C side fixes shader-side color handling.

## 13. Rollback

- Revert EPIC-B commits; `backend/webgl/` retains only EPIC-A stub.
- `FontAtlasGpu.ts` + friends deleted.
- Benches removed.
- ADR 0020 reverts to non-existent.

Canvas2D `FontAtlas` is untouched throughout; production path unaffected. EPIC-C is blocked (its dep); entire RFC 0002 train pauses until B re-lands.

## 14. Cross-references

- **RFC 0002 §7** — canonical design; this epic implements.
- **RFC 0002 §10** — invalidation rules.
- **RFC 0002 §12** — perf-stage budgets this epic's benches enforce.
- **RFC 0002 §14 #3, #4, #8, #15, #17, #18** — owned failure modes.
- **RFC 0001 §14.1** — SHOULD "glyph atlas (shared offscreen, LRU)"; GPU version satisfies stretch.
- **RFC 0001 §22 #19** — web-font late-load; CPU fast path covers.
- **EPIC-A §7** — `warmupAtlas?` hook wired here.
- **EPIC-C §6** — consumes `FontAtlasGpu.bindPage(pageId)` for sampler binding.
- **EPIC-E §9** — uses these benches as the perf baseline source.
- **EPIC-F §8** — uses `BackendDiagnostics.atlasPageDropsLifetime` for perf-cliff detection.

## 15. Day-by-day breakdown

### Week 1

**Day 1** — API freeze + scaffolding
- `FontAtlasGpu` public interface pinned in `types.ts`.
- File skeletons created + barrel wired.
- Unit-test skeleton files with `.skip` placeholders.

**Day 2** — `AtlasPage` + bin-packing
- Row-shelf allocator.
- `AtlasPage.test.ts` green.
- Bench harness skeleton for `raster-hit.bench.ts`.

**Day 3** — `AtlasRasterizer`
- OffscreenCanvas rasterization.
- Fallback in-DOM canvas path for mobile Safari.
- Warmup set definition + `AtlasWarmup.ts`.

**Day 4** — `FontAtlasGpu.getOrRaster` path
- Hit + miss + insertion.
- LRU ordering + eviction.
- `FontAtlasGpu.test.ts` initial 20 cases green.

**Day 5** — `AtlasInvalidation`
- DPR listener, font-family listener, `document.fonts` listener.
- Theme-change **non-invalidation** path.
- Debounce logic.
- `AtlasInvalidation.test.ts` green.

### Week 2

**Day 6** — `AtlasCpuFastPath`
- Slow-raster detection (> 4 ms).
- Canvas2D rasterizer fallback.
- Idle-callback scheduler.
- `AtlasCpuFastPath.test.ts` green.

**Day 7** — Page eviction
- 4-page cap + coldest-page drop.
- Frame-coherence check (no drop of a page referenced by current frame — coordinated with EPIC-C; for this epic, test with a synthetic `currentFrameReferences` set).
- `FontAtlasGpu.test.ts` page-eviction cases.

**Day 8** — Stress + diagnostics
- `FontAtlasGpu.stress.test.ts` 500-cell burst.
- Diagnostics fields populated.
- `WebGLAtlasOnlyBackend` (test-only) wires `reportDiagnostics` to atlas counters.

**Day 9** — Benches
- All 4 atlas benches runnable via `pnpm -F @quanta/ui bench:atlas`.
- Measure on M-series Mac baseline; record numbers.
- Assert p95 ≤ RFC 0002 §12 targets.

**Day 10** — E2E + ADR 0020 + wrap
- 7 e2e tests green.
- ADR 0020 draft complete.
- Audit RFC 0002 §14 #3/#4/#8/#15/#17/#18 — each has a dedicated test.
- Renderer-lead sign-off; tag `FontAtlasGpu` API frozen for EPIC-C.

## 16. Cross-epic handoffs

- **To EPIC-C**: `FontAtlasGpu.bindPage(pageId)` — binds the GL sampler; WebGL shader samples from here. `FontAtlasGpu.getOrRaster(key)` — called by the instance encoder per dirty cell. Page-id stable across frames until invalidation or drop.
- **To EPIC-D**: IME overlay text rasters reuse atlas via `FontAtlasGpu.getOrRaster` with a dedicated `attrsVariant` bit — no new API needed.
- **To EPIC-E**: atlas benches are the perf baseline source. `atlas-miss-recovery.bench.ts` directly informs RFC 0002 §12 "Atlas miss recovery" number.
- **To EPIC-F**: atlas diagnostics feed perf-cliff detection. `BackendDiagnostics.atlasPageDropsLifetime > threshold` signals trouble.
