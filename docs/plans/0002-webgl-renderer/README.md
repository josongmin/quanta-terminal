# Epic Plan — RFC 0002 WebGL/WebGPU Renderer

- **Status**: Design-ahead (Gear 3). Freezes the 6-epic breakdown for WebGL backend delivery behind RFC 0001 §12 `BackendContract`.
- **Date**: 2026-04-20
- **Parent RFC**: `docs/rfc/0002-webgl-renderer.md`
- **Depends on**: RFC 0001 `docs/rfc/0001-custom-vt-engine-xterm-removal.md` fully shipped (§19 gate ALL-TRUE). Canvas2D renderer live as default. `BackendContract` frozen per EPIC-D §4.1 of the 0001 plan.
- **Does not modify**: any crate under `crates/`, any mirror/selection/search/hit-test module under `packages/ui/src/shared/lib/` (grid-mirror, ansi-parser), any feature module under `packages/ui/src/features/`, any Rust source.
- **Scope of this plan**: ONLY the new `WebGLBackend` and the rollout + fallback plumbing.

---

## 1. One-paragraph read

RFC 0001 delivered the VT engine, the mirror, and a Canvas2D `BackendContract` implementation. RFC 0002 replaces the paint backend with a GPU path. Six epics in strict order: **A**udit the backend contract (no semantic changes, only "is it WebGL-shaped?"), build the **B**GPU font atlas, build the **C** instanced glyph renderer, port **D** cursor + selection + IME overlay passes, prove **E** perf baselines against Canvas2D, wire **F** the rollout flag + auto-fallback. Canvas2D remains the shipping default; WebGL is opt-in behind `experimental.renderer = 'webgl'` until the RFC 0002 §20 hard gate is ALL-TRUE.

## 2. Epic table

| Epic | Title | Phase | Duration | Dependencies | Exit |
|------|-------|-------|----------|--------------|------|
| **A** | Backend contract audit | A | 4 d | RFC 0001 §19 ALL-TRUE | Contract surface frozen, WebGL-shaped. `WebGLStubBackend` compiles + passes parity. |
| **B** | Font atlas on GPU | B | 1.5 w | A | Atlas bench green. LRU stress green. CPU-raster fast path proven under atlas-miss burst. |
| **C** | Glyph instancing | C | 2 w | B (atlas API frozen) | Cross-backend pixel diff ≤ ±1 on RFC 0001 compat golden corpus. `backend-contract.test.ts` green on WebGL. |
| **D** | Selection / cursor / IME overlays | D | 1 w | C (VBO layout frozen) | Three-pass paint order preserved. Selection/IME/hyperlink parity tests green. |
| **E** | Perf baseline | E | 1 w | C (draw path stable), may start with stubs before D lands | RFC 0002 §12 target p95 hit for every stage on M-series + Intel Iris. Device matrix captured. |
| **F** | Rollout flag + fallback | F | 1 w | A (detection hooks), E (perf baselines exist) | `experimental.renderer` wired end-to-end. Context-loss + perf-cliff auto-fallback green under fault injection. |

**Total sequential**: ~6–7 weeks + 1.5 weeks contingency.
**Parallel**: E + F may overlap with D as long as API is frozen per A+B+C.

## 3. Dependency graph

```
    ┌────────────────────┐
    │ A — Contract audit │ ──► freezes BackendContract.ts
    └──────────┬─────────┘
               │
               ▼
    ┌────────────────────┐
    │ B — GPU atlas      │ ──► freezes FontAtlasGpu API
    └──────────┬─────────┘
               │
               ▼
    ┌────────────────────┐
    │ C — Glyph          │ ──► freezes CellInstance VBO layout
    │   instancing       │
    └────────┬─┬─────────┘
             │ │
             │ └────────────────┐
             ▼                  ▼
    ┌────────────────┐   ┌────────────────┐
    │ D — Overlays   │   │ E — Perf       │
    └────────┬───────┘   │   baseline     │
             │           └────────┬───────┘
             │                    │
             └──────────┬─────────┘
                        ▼
            ┌────────────────────────────┐
            │ F — Rollout + fallback     │
            └────────────────────────────┘
```

**Contract freeze milestones**:

- After A: `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` has whatever hooks WebGL needs. No further surface changes before v1 ships.
- After B: `FontAtlasGpu` public API frozen — epic C starts against it.
- After C: `CellInstance` VBO layout frozen — epics D + E start against it.
- After F: `experimental.renderer` setting key + telemetry counter names frozen — ADR 0019 accepted.

## 4. Cross-references to RFC 0001

| This plan uses | RFC 0001 section | Semantic |
|----------------|------------------|----------|
| A DoD "no semantic change to contract" | §2 I-1 … I-10 | Invariants preserved |
| A scope "verify renderer-agnosticism" | §12 | Renderer backend contract |
| B atlas key shape | §14.1 | SHOULD — renderer items (glyph atlas) |
| B invalidation rules | §22 #19 | Web-font late-load |
| C truecolor resolve | §11 + §13.7 | Color/mode handling |
| C instanced draw path | §13.13 | Perf budget decomposition |
| D overlay composition order | §13.8 | Selection/copy invariants |
| D IME overlay slot | §10 | IME state machine |
| E perf budgets | §10, §13.12, §13.13 | Stretch perf targets |
| E real-load harnesses | §18 | Perf harness |
| E side-by-side diff | §13.11 | Cross-backend verification |
| F fallback on context-loss | §20 | Degraded-mode contract |
| F telemetry counters | §13.14 | Counter taxonomy |
| F hard gate | §19 pattern | Mirrored gate structure in RFC 0002 §20 |

## 5. "Where we die" failure-mode checklist (paint-layer only)

Aggregated from RFC 0002 §14, sorted by owning epic:

| # | Failure mode | Owning epic |
|---|--------------|-------------|
| 1 | Lost GL context on driver reset | F |
| 2 | Shader compile fail on Mesa/Intel | A, C |
| 3 | Texture page size < 1024 (hard floor) | B |
| 4 | Atlas eviction during a 500-cell burst | B |
| 5 | SGR state-variant explosion → atlas key bloat | C |
| 6 | Instanced draw-call batching wrong | C |
| 7 | Integrated-GPU perf cliff (Intel Iris / AMD Vega) | E |
| 8 | High-DPI Retina rasterization artifacts | B |
| 9 | WebGPU feature detection collides with WebGL | F |
| 10 | Lost overlay handle during IME burst | D |
| 11 | Theme change mid-render | C |
| 12 | Cursor blink desynchronization with Canvas2D | D |
| 13 | Wide-char right-half cell mis-instanced | C |
| 14 | Selection rect crosses page boundary | D |
| 15 | Font-load mid-paint causes atlas tearing | B |
| 16 | Mobile Safari WebGL2 feature gap | F |
| 17 | Driver-level memory exhaustion | B |
| 18 | OffscreenCanvas taint blocks atlas upload | B |
| 19 | Rapid resize causes viewport uniform drift | C |
| 20 | Perf regression CI gate regression | E |
| 21 | `data-renderer="webgl"` left enabled in e2e tests | F |
| 22 | Context-loss happens during snapshot apply | F |
| 23 | `webglcontextrestored` auto-remount corrupts state | F |
| 24 | `backend.perf_fallback` misfires on cold start | F |

Each row has a corresponding test file listed in the owning epic's "Tests" section.

## 6. Scope fences

### In scope

- `packages/ui/src/shared/ui/cell-renderer/backend/webgl/**` — all new, owned by this plan tree
- `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` — additive edits only (hooks WebGL needs), no surface breakage
- `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` — wire up backend-selection prop
- `packages/ui/src/__tests__/perf/**` — new perf harness files
- `docs/adr/0019-backend-selection-fallback.md` — new
- `docs/adr/0020-gpu-atlas-eviction.md` — new

### Out of scope (hard)

- `crates/` — any Rust. Untouched.
- `packages/ui/src/shared/lib/grid-mirror/**` — mirror untouched.
- `packages/ui/src/shared/lib/ansi-parser/**` — parser untouched.
- `packages/ui/src/shared/ui/cell-renderer/Selection.ts` / `HitTest.ts` / `Search.ts` / `CellBuffer.ts` / `Renderer.ts` / `DamageSet.ts` / `FontAtlas.ts` — Canvas2D era files stay unchanged.
- `packages/ui/src/shared/ui/cell-renderer/backend/Canvas2DBackend.ts` / `MemoryBackend.ts` — unchanged.
- `packages/ui/src/features/**` — input / composer / session all untouched.

### Cross-cutting

- ADR 0019 (backend selection) + ADR 0020 (atlas eviction) spawned by this RFC. Drafted in EPIC-A / EPIC-B respectively; accepted in EPIC-F.

## 7. Acceptance gate roll-up

RFC 0002 §20 gate items distributed across epics:

| Gate item | Verified by |
|-----------|-------------|
| Cross-backend pixel diff zero | EPIC-C + EPIC-D |
| §12 perf targets green | EPIC-E |
| `webglcontextlost` recovery ≤ 1 frame | EPIC-F |
| Perf-cliff auto-fallback | EPIC-F |
| Canvas2D fallback mount ≤ 20 ms | EPIC-F |
| `experimental.renderer` setting works | EPIC-F |
| ADR 0019 accepted | EPIC-F |
| ADR 0020 accepted | EPIC-B → EPIC-F |
| `backend-contract.test.ts` green on WebGL | EPIC-A + EPIC-C |
| Selection/copy/search/hyperlink parity | EPIC-D |
| No new contract method without Canvas2D/Memory impl | EPIC-A |
| Mobile matrix green or falls back | EPIC-F |
| 1 week dogfood clean | EPIC-F |
| Context-lost rate < 1 / 24 h | EPIC-F |
| No regression 1 week | EPIC-F |

## 8. Reading order

1. `docs/rfc/0002-webgl-renderer.md` — strategic document.
2. `docs/plans/0002-webgl-renderer/README.md` (this file) — dependency map.
3. Epic files in order A → B → C → D → E → F.
4. RFC 0001 §12, §13.11–§13.14, §19, §20 — parent contract references.
5. `docs/plans/0001-custom-vt-engine-xterm-removal/epic-D-canvas-renderer-selection.md` — the Canvas2D implementation being paralleled.
