# EPIC-A — Backend Contract Audit

- **Status**: Design-ahead. Freezes the `BackendContract` surface for WebGL consumption. No semantic changes.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §12 (renderer backend contract), RFC 0001 §13.11 (cross-backend diff), RFC 0001 §14.1 (SHOULD renderer items), EPIC-D of RFC 0001 plan (Canvas2D reference impl), `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` (the surface under audit).
- **Spawns**: ADR 0019 draft (`docs/adr/0019-backend-selection-fallback.md`), scoped to the setting key + detection matrix. Accepted in EPIC-F.

---

## 1. Goal

Verify `BackendContract` is fully renderer-agnostic and WebGL-capable before writing a single line of GPU code. Add only the hooks WebGL genuinely needs; refuse to add hooks Canvas2D / Memory cannot satisfy. Produce a `WebGLStubBackend` that compiles and passes the existing parity suite as a tripwire — if the contract ever drifts WebGL-only, the stub breaks first.

## 2. Phase

Phase A of RFC 0002 §17 migration plan. First epic in the dependency graph. No upstream work blocks it (beyond RFC 0001 §19 being ALL-TRUE, i.e. xterm removed + Canvas2D live).

## 3. Duration

4 days.

## 4. Dependencies

- **RFC 0001 §19 gate green** — Canvas2D is sole production renderer; xterm removed; CI grep rules live.
- **EPIC-D of RFC 0001 plan shipped** — Canvas2DBackend, MemoryBackend, `backend-contract.test.ts`, `cell-renderer` tree all live.
- **No upstream blockers from other RFC 0002 epics.**

## 5. Scope

### 5.1 In

- Audit `BackendContract.ts` against WebGL implementation demands. Produce a written gap list.
- Add hooks where gaps exist AND all backends can satisfy them. Examples (confirmed in §7):
  - `onContextLost?(): void` optional lifecycle hook (Canvas2D no-op, Memory no-op, WebGL non-null).
  - `reportDiagnostics?(): BackendDiagnostics` telemetry hook (Canvas2D returns static data, Memory returns static, WebGL reports GL state).
  - `warmupAtlas?(set: readonly string[]): void` optional pre-raster hook (Canvas2D implements, Memory no-op, WebGL implements).
- Refuse GL-specific hooks. If the WebGL backend needs something un-emulable by Canvas2D / Memory, solve it **inside** `WebGLBackend` private API.
- Write `WebGLStubBackend.ts` — no-op paint, full contract surface, returns empty `BackendDiagnostics`. Purpose: trip the parity suite if any future PR adds a WebGL-only surface.
- Extend `backend-contract.test.ts` with `WebGLStub` as a tested backend entry.
- Update EPIC-D design doc cross-reference in an "audit companion note" — we **do not** edit EPIC-D; we create a forward reference in RFC 0002 (already done at §22 of RFC 0002).
- Draft ADR 0019 (setting key + detection matrix + fallback policy). Do not accept yet.

### 5.2 Out

- Any WebGL-specific code (shaders, textures, VBOs) — EPIC-B/C/D.
- Atlas implementation — EPIC-B.
- Rollout flag wiring — EPIC-F.
- ADR 0020 — drafted in EPIC-B.
- Canvas2D modifications — never. Read-only here.
- Mirror / Selection / HitTest / Search changes — never. Scope fence from RFC 0002 §3.

## 6. Files

All new unless marked `updated`.

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` | **Updated** — optional additive hooks (`onContextLost?`, `reportDiagnostics?`, `warmupAtlas?`). No required-method changes. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/WebGLStubBackend.ts` | New — empty WebGL stub, full contract surface, returns sentinel diagnostics. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/index.ts` | New — barrel export, marks the `webgl` submodule boundary. |
| `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/webgl-stub.test.ts` | New — mounts stub, asserts contract parity with Canvas2D under no-paint scenarios. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/backend-contract.test.ts` | **Updated** — add `WebGLStub` to the backend list under parity suite. |
| `packages/ui/src/shared/ui/cell-renderer/types.ts` | **Updated** — add `BackendDiagnostics` type + `InvalidationReasonGpu` extensions (type-only; no runtime). |
| `docs/adr/0019-backend-selection-fallback.md` | New — draft only (Proposed). |
| `docs/plans/0002-webgl-renderer/audit-report.md` | New — the written audit gap list (consumed by EPIC-B/C planning). |

## 7. Definition of Done (DoD)

Every item a hard checkbox. Missing one = epic does not exit.

- [ ] `BackendContract.ts` audit report produced at `docs/plans/0002-webgl-renderer/audit-report.md`. Report covers every method against every WebGL demand.
- [ ] Audit report lists ≤ 3 hooks to add; each justified + each satisfiable by all three backends.
- [ ] Proposed hooks added to `BackendContract.ts` as **optional** (`?:`) methods only. No required-method breakage.
- [ ] `BackendDiagnostics` type added to `types.ts`. Fields: `backendName`, `atlasEntries`, `atlasPages`, `droppedFrames`, `contextLostCount`.
- [ ] `WebGLStubBackend` compiles standalone, exports via barrel, implements full contract.
- [ ] `WebGLStubBackend.applyGridSnapshot` / `applyGridDelta` / `applyCursor` / `applyMode` / `applyMetrics` / `requestDamageFlush` are measurably no-op (no DOM mutation, no allocation > 256 B per call — asserted in test).
- [ ] `WebGLStubBackend.screenToCell` / `cellToScreen` / `measureText` are **not** no-op — they compute correctly from `MountContext.metrics`, matching Canvas2DBackend byte-for-byte (tested).
- [ ] `WebGLStubBackend.mountOverlay` / `updateOverlay` / `unmountOverlay` return symbol handles that are idempotent on re-unmount.
- [ ] `backend-contract.test.ts` runs every existing invariant case against `WebGLStub`. All green.
- [ ] No new grep-rule violations: `grep -r "gl.\|WebGLRenderingContext\|WebGL2RenderingContext" packages/ui/src/shared/ui/cell-renderer/backend/` shows matches only inside `backend/webgl/`.
- [ ] `Canvas2DBackend` and `MemoryBackend` implement the new optional hooks or explicitly declare `undefined` for them (TS-checked).
- [ ] ADR 0019 draft at `docs/adr/0019-backend-selection-fallback.md`. Sections: Title, Context, Decision, Alternatives, Consequences, Open Questions. Status: Proposed.
- [ ] `types.ts` additions pure-type (type-only imports; no runtime).
- [ ] `backend/webgl/index.ts` barrel re-exports `WebGLStubBackend` only.
- [ ] RFC 0002 §22 cross-reference table spot-checked against the audit report; any missing references filed as EPIC-B/C/D todos.
- [ ] `pnpm -F @quanta/ui test` green.
- [ ] `pnpm -F @quanta/ui lint` green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.

## 8. Quality gates

- **Zero surface change to required methods.** If a required-method signature changes, audit fails; Canvas2D would have to be edited which is out of scope.
- **TS strict mode.** All optional hooks consumed via `backend.reportDiagnostics?.()` or equivalent. No `as any`.
- **ESLint `no-restricted-imports`** — prevent `webgl/**` from importing `Canvas2DBackend` / `MemoryBackend`. Each backend is self-contained.
- **Grep rule** (CI): no WebGL type references outside `backend/webgl/`.
- **`backend-contract.test.ts` coverage** ≥ 95 % on `WebGLStubBackend`.
- **Audit-report sign-off** — human reviewer (renderer lead) signs the report before EPIC-B starts.
- **ADR 0019 draft reviewed** — not accepted, but reviewed before EPIC-F starts.

## 9. E2E tests

Each an `@quanta/ui` integration test. Minimum 5:

1. `packages/ui/src/__tests__/e2e/webgl-stub-mount.e2e.test.tsx` — mount `TerminalCanvas` with `backend='webglStub'` prop; renders (no paint); responds to `GridMirror` lifecycle; unmounts clean.
2. `packages/ui/src/__tests__/e2e/webgl-stub-hit-test.e2e.test.tsx` — mount stub; feed a mirror snapshot; click cells at various coords; assert `onHyperlinkClick` + `onPointerEvent` fire with identical row/col as Canvas2D under the same inputs.
3. `packages/ui/src/__tests__/e2e/webgl-stub-selection.e2e.test.tsx` — mount stub; drive Selection through a full range; copy roundtrip byte-identical vs Canvas2D under same mirror state.
4. `packages/ui/src/__tests__/e2e/webgl-stub-diagnostics.e2e.test.tsx` — mount stub; wait 1 s; read diagnostics; assert `atlasEntries = 0`, `atlasPages = 0`, `droppedFrames = 0`, `contextLostCount = 0`.
5. `packages/ui/src/__tests__/e2e/webgl-stub-swap.e2e.test.tsx` — mount stub; mid-session swap to Canvas2D via re-render; mirror state preserved (snapshot re-applies); no leak.
6. `packages/ui/src/__tests__/e2e/backend-contract-parity.e2e.test.tsx` — harness loops over `['canvas', 'memory', 'webglStub']`, runs the parity suite; all pass.

## 10. Unit tests

- `webgl-stub.test.ts` — every method smoke-tested. Overlay handle idempotence. No-op assertions via spies on `HTMLCanvasElement.getContext`.
- `backend-contract.test.ts` — existing suite extended; runs against 3 backends now.
- `types.ts` is compile-time only; covered by TS strict + a `type-check.test.ts` holding trivial `satisfies` assertions.
- Audit-report — not a test, but the file's existence is checked by a CI dir-lint (`tools/ci/check-audit-report.ts`? — no; skipped in this epic; added if needed in F).

## 11. Failure modes

- **Audit misses a hook WebGL needs.** Symptom: EPIC-B cannot implement atlas warmup without mutating state Canvas2D doesn't expose. Mitigation: audit-report reviewed by renderer lead pre-EPIC-B kickoff. Recovery: amend contract with another additive hook.
- **Audit adds a hook Canvas2D can't satisfy.** Symptom: `Canvas2DBackend` breaks the parity suite. Mitigation: hook is `?:` optional; Canvas2D declares undefined. If genuinely unavoidable, hook is rejected and solved inside `WebGLBackend` private API.
- **`WebGLStubBackend` diverges from Canvas2D in hit-test/measure.** Symptom: parity suite fails. Mitigation: stub inherits hit-test/measure from a shared helper (`cell-renderer/backend/shared/metrics-math.ts`?) — NO, scope fence says we do not modify shared files; instead stub reimplements against `MountContext.metrics` and test asserts equality.
- **Grep rule fires on `backend/webgl/WebGLStubBackend.ts`** — WebGL types inside the module are allowed; grep rule excludes `backend/webgl/**`.
- **ADR 0019 review blocked.** Epic still exits with ADR in Proposed status; EPIC-F reviews + accepts.
- **TS strict fails on optional-hook invocation.** Mitigation: consumer uses `backend.reportDiagnostics?.() ?? fallbackDiagnostics`. CI enforces.

## 12. Risks

- **Contract drift under stakeholder pressure** — "WebGL needs just one thing that Canvas2D can't do" — mitigated by the stub tripwire. The parity suite is the contract's jury.
- **Audit underestimates WebGL needs** — known-unknown. Mitigated by keeping EPIC-B/C/D design-ahead docs open to additive hooks as they discover needs, PROVIDED each new hook goes through this epic's gates.
- **ADR 0019 review blocks EPIC-F start** — mitigated by drafting here and accepting in F.
- **Canvas2D lead disagrees with hook additions** — resolved at renderer-lead sign-off.

## 13. Rollback

- Revert the `BackendContract.ts` additive edits (3 optional methods).
- Delete `backend/webgl/` directory.
- Revert `types.ts` additive type.
- Revert `backend-contract.test.ts` WebGLStub entry.
- Revert ADR 0019 file.

Total rollback footprint: ~200 LOC + 1 directory + 1 file. No other code paths depend on this epic's work pre-EPIC-B.

## 14. Cross-references

- **RFC 0001 §12** — contract authority; this epic's audit target.
- **RFC 0001 §13.11** — side-by-side diff harness; extended in EPIC-E.
- **RFC 0001 §14.1** — SHOULD renderer items; WebGL gets the stretch.
- **RFC 0001 EPIC-D §4.1** — reference Canvas2D contract doc.
- **RFC 0002 §11** — fallback policy, basis for ADR 0019.
- **RFC 0002 §14** — failure-mode checklist; #2 (shader compile) touches this epic's stub boundary.
- **RFC 0002 §20** — gate items "no new method without Canvas2D/Memory impl" + "`backend-contract.test.ts` green on WebGL" — this epic produces the green-on-stub baseline.
- **EPIC-B §6** — consumes `warmupAtlas?` hook added here.
- **EPIC-F §8** — consumes `onContextLost?` hook added here.

## 15. Day-by-day breakdown

### Day 1 — Audit

- Morning: read `BackendContract.ts`, map every method against RFC 0002 §6/§7/§8 architecture needs.
- Afternoon: produce `docs/plans/0002-webgl-renderer/audit-report.md`. Enumerate:
  - methods WebGL can fully satisfy as-is (expected majority);
  - methods WebGL needs a new hook to interoperate cleanly (expected ≤ 3);
  - WebGL-internal primitives that should NOT enter the contract.
- Evening: renderer lead review of audit report.

### Day 2 — Surface edits + stub

- Morning: apply the ≤ 3 additive hooks to `BackendContract.ts`. Confirm TS compiles across all callers. Update `Canvas2DBackend` and `MemoryBackend` to declare optional hooks as `undefined` (or trivial impl).
- Midday: add `BackendDiagnostics` type + `InvalidationReasonGpu` string-union additions in `types.ts`.
- Afternoon: write `WebGLStubBackend.ts`. No-op paint methods; correct hit-test / measure; idempotent overlay handles.
- Evening: add `backend/webgl/index.ts` barrel.

### Day 3 — Parity suite + tests

- Morning: extend `backend-contract.test.ts` with `WebGLStub` entry. Run existing invariant cases; fix stub until all pass.
- Midday: write `webgl-stub.test.ts` unit tests.
- Afternoon: write the 6 e2e tests in §9.
- Evening: `pnpm -F @quanta/ui test`, `pnpm -F @quanta/ui lint`, `pnpm typecheck`, `pnpm build` all green.

### Day 4 — ADR + sign-off

- Morning: draft `docs/adr/0019-backend-selection-fallback.md`. Status: Proposed.
- Midday: re-read RFC 0002 §11 + §14 + §20; cross-check ADR against gate items.
- Afternoon: renderer-lead sign-off session. Close audit.
- Evening: tag contract freeze milestone; notify EPIC-B owners.

## 16. What this epic does NOT do

- Does not implement WebGL anything beyond the stub.
- Does not accept ADR 0019.
- Does not modify Canvas2DBackend or MemoryBackend behavior — only adds optional no-op hook declarations.
- Does not wire the `experimental.renderer` setting — EPIC-F.
- Does not touch any perf harness — EPIC-E.
- Does not change `BackendContract` required-method signatures. Any change there is an RFC amendment, not an epic.

## 17. Cross-epic handoffs

- **To EPIC-B**: `warmupAtlas?` hook + `BackendDiagnostics` type + audit-report gaps filed as todos.
- **To EPIC-F**: `onContextLost?` hook + ADR 0019 draft.
- **To EPIC-C**: contract surface confirmed frozen; can begin VBO encoder design against stable API.
- **To EPIC-E**: `reportDiagnostics?` hook for perf-fallback detection.
