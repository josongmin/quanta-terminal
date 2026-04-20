# EPIC-F — Rollout Flag + Canvas2D Fallback

- **Status**: Design-ahead. Freezes `experimental.renderer` setting, feature-detection matrix, context-loss recovery, perf-cliff auto-fallback, telemetry taxonomy, and ADR 0019 + ADR 0020 acceptance.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §13.14 (telemetry counters), RFC 0001 §19 (hard-gate pattern — mirrored at RFC 0002 §20), RFC 0001 §20 (degraded-mode contract), RFC 0002 §11 (device detection + fallback), RFC 0002 §14 #1/#7/#9/#16/#21/#22/#23/#24, RFC 0002 §15 (WebGPU bridge), RFC 0002 §20 (acceptance gate), ADR 0019 (backend selection — accepted here), ADR 0020 (atlas eviction — accepted here).

---

## 1. Goal

Ship WebGL as an opt-in behind `experimental.renderer = 'webgl'` with automatic Canvas2D fallback under context loss, feature-detection failure, and perf cliff. Land ADR 0019 + ADR 0020. Close RFC 0002 §20 acceptance gate. Canvas2D remains production default; WebGL never becomes default in v1 regardless of gate outcome (that's a follow-up RFC).

## 2. Phase

Phase F of RFC 0002 §17. Last epic. Starts after EPIC-E exits (perf baselines captured) — EPIC-D must also exit for overlay parity to be gate-verified.

## 3. Duration

1 week.

## 4. Dependencies

- **EPIC-A exit**: `onContextLost?` + `reportDiagnostics?` hooks; ADR 0019 draft exists.
- **EPIC-B exit**: ADR 0020 draft exists.
- **EPIC-C exit**: `WebGLBackend` real paint live.
- **EPIC-D exit**: overlay passes complete; full selection / copy / search / IME parity.
- **EPIC-E exit**: perf baselines captured; perf-cliff thresholds known.
- **RFC 0001 §20 (degraded mode)** — fallback is a degraded-mode transition; inherits the "no black screen" rule.

## 5. Scope

### 5.1 In

- `experimental.renderer: 'canvas' | 'webgl'` setting wired end-to-end: user-settings schema + settings UI row + backend selection in `TerminalCanvas`.
- Feature-detection matrix at mount (WebGL2 + extensions + texture size + shader compile + sentinel-glyph round trip).
- `webglcontextlost` handler: preventDefault → unmount WebGL → mount Canvas2D → re-apply last snapshot. User-visible duration ≤ 1 frame.
- `webglcontextrestored` handler: telemetry emit; NO auto-remount in-session; require manual reload to re-enable WebGL.
- Perf-cliff detector: if `frame_p95 > 2 × baseline` sustained 5 s, emit `backend.perf_fallback`, swap to Canvas2D.
- Telemetry counters: `backend.mount_ok`, `backend.mount_fallback{reason=...}`, `backend.context_lost`, `backend.context_restored`, `backend.perf_fallback`, `backend.manual_fallback`, `backend.atlas_page_drop_count`, `backend.cpu_fast_path_hit`. Tagged `backend=canvas|webgl`.
- Banner / diagnostic surface (reusable from degraded-mode banner work): "Switched to compatible renderer — details".
- Accept ADR 0019 + ADR 0020.
- Dogfood rollout checklist.
- Close RFC 0002 §20 gate.

### 5.2 Out

- WebGPU implementation — RFC 0002.1.
- Changing the default from Canvas2D to WebGL — follow-up RFC once gate is green for ≥ 1 month in production.
- Native / non-browser backends — never.
- Any change to `Selection.ts`, `HitTest.ts`, `Search.ts` — never.
- Any crate / Rust change — never.
- Any change to the VT engine — never.

## 6. Files

All new unless marked `updated`.

### 6.1 Setting + selection

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/config/experimental-renderer.ts` | Setting schema, getter, setter, default `'canvas'`. |
| `packages/ui/src/shared/config/__tests__/experimental-renderer.test.ts` | Unit: getter, setter, persistence, default. |
| `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` | **Updated** — `backend` prop resolved from setting; mount logic branches. |
| `packages/ui/src/widgets/terminal-canvas/backend-resolver.ts` | Resolves `'webgl' | 'canvas'` to backend instance after feature-detect. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/backend-resolver.test.ts` | Unit: resolution under various feature-detect outcomes. |
| `packages/ui/src/widgets/settings/experimental-renderer-row.tsx` | Settings UI row (if a settings UI exists; otherwise a developer-settings JSON note). |

### 6.2 Feature detection + fallback

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/FeatureDetect.ts` | Runs the detection matrix; returns pass/fail + reason. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/ContextLossHandler.ts` | Owns the `webglcontextlost` / `webglcontextrestored` listeners and orchestrates backend swap. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/PerfCliffDetector.ts` | Frame-time EMA + threshold crossing detection. |
| `packages/ui/src/shared/ui/cell-renderer/backend/FallbackOrchestrator.ts` | Unified unmount-WebGL / mount-Canvas2D / re-apply-snapshot flow. Shared across all three fallback paths. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/FeatureDetect.test.ts` | Unit: each detection failure path. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/ContextLossHandler.test.ts` | Unit: lost → fallback; restored → telemetry only. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/PerfCliffDetector.test.ts` | Unit: EMA math, threshold crossing, warmup exclusion. |
| `packages/ui/src/shared/ui/cell-renderer/backend/__tests__/FallbackOrchestrator.test.ts` | Unit: swap correctness, snapshot re-apply. |

### 6.3 Telemetry

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/telemetry/backend-counters.ts` | Counter names + emit helpers. |
| `packages/ui/src/shared/telemetry/__tests__/backend-counters.test.ts` | Unit: counter increment + tagging. |

### 6.4 Banner

| File | Purpose |
|------|---------|
| `packages/ui/src/widgets/degraded-banner/backend-fallback-banner.tsx` | Banner variant for backend fallback events (reuses degraded-banner chassis). |

### 6.5 Fault injection + E2E

| File | Purpose |
|------|---------|
| `packages/ui/src/__tests__/e2e/context-loss-recovery.e2e.test.tsx` | Fault inject `webglcontextlost`; assert recovery. |
| `packages/ui/src/__tests__/e2e/perf-cliff-fallback.e2e.test.tsx` | Synthetic 2× slowdown; assert perf-fallback fires. |
| `packages/ui/src/__tests__/e2e/feature-detect-fallback.e2e.test.tsx` | Mock feature-detect fail; assert Canvas2D mounts. |
| `packages/ui/src/__tests__/e2e/manual-backend-swap.e2e.test.tsx` | User toggles setting; backend swaps. |
| `packages/ui/src/__tests__/e2e/telemetry-backend-counters.e2e.test.tsx` | Counters emit on each event. |
| `packages/ui/src/__tests__/e2e/fallback-banner.e2e.test.tsx` | Banner visible on auto-fallback; dismissable. |
| `packages/ui/src/__tests__/e2e/cold-start-detect-ok.e2e.test.tsx` | Cold-start perf exclusion window; no false perf-fallback. |
| `packages/ui/src/__tests__/e2e/webgl-context-restored-no-remount.e2e.test.tsx` | Context restored → telemetry emits; backend does NOT auto-remount. |

### 6.6 ADRs

| File | Purpose |
|------|---------|
| `docs/adr/0019-backend-selection-fallback.md` | **Updated** — Proposed → Accepted. |
| `docs/adr/0020-gpu-atlas-eviction.md` | **Updated** — Proposed → Accepted. |

### 6.7 Rollout checklist

| File | Purpose |
|------|---------|
| `docs/plans/0002-webgl-renderer/rollout-checklist.md` | Acceptance gate items checkmark list + dogfood log template. |

## 7. Definition of Done

### 7.1 Setting + UX

- [ ] `experimental.renderer` schema committed; default `'canvas'`.
- [ ] Settings UI row rendering the toggle (if UI present); developer-note documented.
- [ ] `TerminalCanvas` reads setting at mount; re-mounts on setting change.
- [ ] Setting persists across sessions via the app's user-settings layer.

### 7.2 Feature detection

- [ ] Detection matrix runs at WebGL mount:
  - WebGL2 context non-null
  - `EXT_color_buffer_float` (if required by shader path) present
  - Instancing via `gl.vertexAttribDivisor` callable
  - `MAX_TEXTURE_SIZE ≥ 1024`
  - `MAX_ARRAY_TEXTURE_LAYERS ≥ 2`
  - Shader compile + link success
  - 3 sentinel glyphs (ASCII, CJK, emoji) round-trip upload + render
- [ ] Any failure → `FallbackOrchestrator.fallbackToCanvas(reason)` → telemetry `backend.mount_fallback{reason=...}`.
- [ ] Success → telemetry `backend.mount_ok{backend=webgl}`.

### 7.3 Context loss

- [ ] `webglcontextlost` listener registered on the `<canvas>` element inside `WebGLBackend.mount()`.
- [ ] Handler `preventDefault()`, emits `backend.context_lost`, calls `FallbackOrchestrator.fallbackToCanvas('context_lost')`.
- [ ] Canvas2D mounts within 1 frame (≤ 16.7 ms at 60 Hz); tested.
- [ ] Last snapshot re-applied from `GridMirror`; cursor + mode preserved.
- [ ] `webglcontextrestored` listener emits `backend.context_restored`; no auto-remount.

### 7.4 Perf cliff

- [ ] `PerfCliffDetector` samples frame time from `requestDamageFlush` timing.
- [ ] EMA window: 60 frames (~1 s).
- [ ] Threshold: `frame_p95 > 2 × baseline` per current device's baseline (loaded from `perf-baselines/*.json` at mount).
- [ ] Crossing sustained 5 s → `FallbackOrchestrator.fallbackToCanvas('perf_cliff')`.
- [ ] Cold-start exclusion: first 5 s post-mount ignored.
- [ ] Detector can be disabled via `experimental.renderer.no_auto_fallback = true` for debugging.

### 7.5 Fallback orchestrator

- [ ] Single entry point used by all three fallback paths.
- [ ] Sequence: unmount WebGL → mount Canvas2D → `applyGridSnapshot(lastSnapshot)` → re-apply overlays (consumers re-mount via contract).
- [ ] Snapshot source: `GridMirror.getCurrentSnapshot()` (existing API).
- [ ] Backend mount time ≤ 20 ms post-unmount; tested.
- [ ] Idempotent: repeated calls on already-fallback state are no-ops.

### 7.6 Telemetry

- [ ] 8 counters implemented per §5.1 list.
- [ ] All tagged `backend=canvas|webgl`.
- [ ] Dashboard / log output verified in dev.
- [ ] RFC 0001 §13.14 counter list extended at RFC 0001 acceptance review (documentation note; no source edit there).

### 7.7 Banner

- [ ] `BackendFallbackBanner` appears on any auto-fallback event.
- [ ] Dismissable; does not reappear in the same session.
- [ ] Visible in UI tests.

### 7.8 ADRs

- [ ] ADR 0019 Accepted. Fields filled: backend-selection decision, detection matrix, fallback policy, setting key, telemetry taxonomy.
- [ ] ADR 0020 Accepted. Fields filled: page cap, per-page LRU rule, page-drop threshold, vram bound.

### 7.9 RFC 0002 §20 gate

Every item in RFC 0002 §20 acceptance gate is CHECKED OFF:

- [ ] Cross-backend pixel diff zero across RFC 0001 §13.9 compat matrix.
- [ ] §12 perf targets green on M-series + Intel Iris.
- [ ] `webglcontextlost` fault injection recovery ≤ 1 frame verified.
- [ ] Auto-fallback on perf cliff verified under 2× slowdown injection.
- [ ] Canvas2D fallback mount ≤ 20 ms.
- [ ] `experimental.renderer` persists; toggleable.
- [ ] ADR 0019 accepted.
- [ ] ADR 0020 accepted.
- [ ] `backend-contract.test.ts` green on WebGL.
- [ ] Selection / copy / search / hyperlink parity green.
- [ ] No new `BackendContract` method lacks Canvas2D / Memory impl.
- [ ] Mobile matrix green or clean fallback.
- [ ] 1 week dogfood clean.
- [ ] Context-lost rate < 1 / 24 h on dogfood fleet.
- [ ] No selection / search / copy regression over 1 week.

### 7.10 General

- [ ] `pnpm -F @quanta/ui test` green.
- [ ] `pnpm -F @quanta/ui lint` green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.
- [ ] `pnpm -F @quanta/ui test:e2e` green across all new e2e tests.
- [ ] `rollout-checklist.md` populated with sign-off checkboxes per gate.

## 8. Quality gates

- **No auto-fallback storm** — once fallback fires, session stays Canvas2D; only a manual toggle + reload re-arms WebGL.
- **No data loss on swap** — `GridMirror` is authoritative; snapshot re-apply is complete.
- **No visible flash** — backend swap completes within 1 frame at 60 Hz.
- **Telemetry complete** — every fallback path has a named counter.
- **ADR 0019 + 0020 Accepted** — non-negotiable.
- **Dogfood clean for 7 days** — daily dogfood log in `rollout-checklist.md`.
- **Context-lost incident rate < 1 / 24 h** — measured across dogfood fleet.
- **Cold-start perf-detector exclusion** — 5 s warm-up verified; no false-positive perf fallback.
- **Test lane default Canvas2D** — no e2e test uses WebGL unless explicitly opted-in; prevents non-determinism from driver differences.

## 9. E2E tests (≥ 5 — §5.5 lists 8)

See `§6.5`. Each covers a specific gate item.

## 10. Unit tests

- `FeatureDetect.test.ts` — each failure path.
- `ContextLossHandler.test.ts` — lost → fallback; restored → telemetry only.
- `PerfCliffDetector.test.ts` — EMA math, cold-start exclusion, threshold crossing.
- `FallbackOrchestrator.test.ts` — swap correctness, snapshot re-apply, idempotence.
- `backend-resolver.test.ts` — setting resolution under detect outcomes.
- `experimental-renderer.test.ts` — persistence, default.
- `backend-counters.test.ts` — counter emission, tagging.

## 11. Failure modes

- **Context loss during snapshot apply** — fallback orchestrator re-queues the apply on Canvas2D; asserted.
- **Context restored auto-remount regresses perf** — disabled by design; user must reload.
- **Perf-fallback misfires during htop burst** — 5-s sustained window + EMA damping prevents single-spike trigger.
- **Feature detect passes but runtime shader crash** — runtime shader errors trigger context-loss-like fallback via a dedicated error hook; tested.
- **User flag toggles during a mid-frame** — setting change applies at next mount; no mid-frame backend swap.
- **Fallback banner invisible** — banner component tested mounted + visible.
- **Dogfood fleet heterogeneity hides bug** — dogfood log per device class.
- **Mobile Safari WebGL2 feature gap on iOS 14** — detection fails clean; Canvas2D serves.
- **Android Chrome variant lacks `EXT_color_buffer_float`** — detection catches; fallback fires.
- **Shader compile fail on Mesa with rare Intel driver** — caught at mount; fallback fires. Log includes driver string via `WEBGL_debug_renderer_info`.
- **`data-renderer="webgl"` left enabled in CI e2e by accident** — CI default is `canvas`; WebGL tests opt-in via explicit setting override in test harness.
- **Perf-cliff detector uses wrong baseline per-device** — baseline selection uses `WEBGL_debug_renderer_info` renderer string hash; defaults to M-series if unknown.
- **Telemetry counter names collide with existing RFC 0001** — counters prefixed `backend.*`; reviewed.
- **Banner dismiss doesn't persist within session** — dismiss state in sessionStorage; tested.
- **ADR 0019 review blocks acceptance** — reviewer alignment session scheduled Day 5.
- **`WEBGL_lose_context` extension unavailable in test env** — fault injection uses a wrapper that also calls handler directly when the extension is missing.
- **`GridMirror.getCurrentSnapshot()` not a public method** — if missing, add it in RFC 0001 plan Post-Acceptance? — NO, should already exist per EPIC-C API. If not, this epic blocks on a tiny additive PR to the mirror (scope fence carved out by reviewer).

## 12. Risks

- **Dogfood fleet not 1 week clean** — extend dogfood; gate does not slip into production default.
- **Mobile hardware variance** — documented in device matrix (EPIC-E); gate allows "clean fallback" as pass.
- **ADR 0019 scope creep** — keep decision record focused on selection + fallback, not broader renderer policy.
- **Perf-cliff detector noise** — tunable; first-week-of-dogfood may require threshold adjustment.
- **Banner UX controversial** — "switched to compatible renderer" wording reviewed with design.
- **Context-loss incident > 1 / 24 h** — blocks acceptance; triage root cause; likely driver-specific; add to device-matrix fallback list.

## 13. Rollback

- Revert EPIC-F commits.
- `experimental.renderer` setting removed from schema.
- Feature detect / context loss / perf cliff / orchestrator / banner deleted.
- ADR 0019 + 0020 revert to Proposed.
- WebGL code (EPIC-B/C/D) remains in tree but unreachable (no way to mount).

Production path is Canvas2D throughout; no user-visible change from the revert. EPIC-A stub remains as the contract tripwire.

## 14. Cross-references

- **RFC 0001 §13.14** — counters extended with `backend` tag; documentation follow-up.
- **RFC 0001 §19 pattern** — RFC 0002 §20 mirrors; this epic closes it.
- **RFC 0001 §20 degraded-mode contract** — backend fallback is a degraded-mode transition; inherits "no black screen".
- **RFC 0002 §11** — canonical detection + fallback design.
- **RFC 0002 §14 #1, #7, #9, #16, #21, #22, #23, #24** — owned failure modes.
- **RFC 0002 §15 (WebGPU bridge)** — this epic does not ship WebGPU; does not preclude RFC 0002.1.
- **RFC 0002 §20** — this epic's DoD is the gate checklist.
- **EPIC-A** — hooks consumed (`onContextLost?`, `reportDiagnostics?`); ADR 0019 drafted there.
- **EPIC-B** — ADR 0020 drafted there.
- **EPIC-C** — WebGLBackend target of the lifecycle operations.
- **EPIC-D** — overlay parity gate item.
- **EPIC-E** — perf baselines consumed by `PerfCliffDetector`.
- **`packages/ui/src/features/degraded-mode/`** — banner reuse; read-only reference.

## 15. Day-by-day breakdown

### Day 1 — Setting + resolver
- `experimental-renderer.ts` schema + persistence.
- `backend-resolver.ts` with feature-detect injection.
- `TerminalCanvas.tsx` updated to consume setting.
- Unit tests green.

### Day 2 — Feature detection
- `FeatureDetect.ts` matrix.
- Unit tests for each failure path.
- Wire into `WebGLBackend.mount()`.

### Day 3 — Context loss + fallback orchestrator
- `ContextLossHandler.ts`.
- `FallbackOrchestrator.ts`.
- Unit tests green.
- E2E fault-injection test green.

### Day 4 — Perf cliff + banner
- `PerfCliffDetector.ts`.
- `BackendFallbackBanner.tsx`.
- Unit tests green.
- E2E perf-cliff test green.

### Day 5 — Telemetry + ADRs
- `backend-counters.ts` + emit helpers.
- Wire counters to all events.
- ADR 0019 review + acceptance session.
- ADR 0020 review + acceptance session.

### Day 6 — E2E harvest + dogfood prep
- All 8 e2e tests green.
- `rollout-checklist.md` populated.
- Dogfood announcement + instructions.

### Day 7 — Gate close
- RFC 0002 §20 items ticked.
- Dogfood log template distributed.
- Tag release `rfc0002-webgl-ready-opt-in`.
- Announce: WebGL available behind flag; Canvas2D remains default.

## 16. Cross-epic handoffs

- **Back to RFC 0002 §20 sign-off**: gate checklist closed.
- **Forward to RFC 0002.1 (WebGPU bridge)**: `FallbackOrchestrator` pattern reused; `FeatureDetect` extended with `webgpu` probe first; setting adds `'webgpu'` option.
- **To production enablement**: once dogfood + gate green for ≥ 1 month, a follow-up RFC may flip the default from `'canvas'` to `'webgl'`. NOT this RFC.
