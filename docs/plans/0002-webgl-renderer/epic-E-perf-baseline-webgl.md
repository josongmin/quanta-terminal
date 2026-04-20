# EPIC-E — Perf Baseline Capture

- **Status**: Design-ahead. Freezes the bench corpus + real-load harness + device matrix + CI perf-regression gate for the WebGL backend.
- **Date**: 2026-04-20
- **Parent**: `docs/rfc/0002-webgl-renderer.md`
- **Related**: RFC 0001 §13.12 (performance gate), RFC 0001 §13.13 (performance budget decomposition), RFC 0001 §13.14 (telemetry counters), RFC 0001 §18 (perf harness testing strategy), RFC 0002 §4.1 (stretch perf goals), RFC 0002 §12 (perf budget decomposition table), RFC 0002 §13 (six-axis success — axis 2 "perf budget met"), RFC 0002 §14 #7/#20.

---

## 1. Goal

Capture the authoritative WebGL perf baseline and prove it meets every target in RFC 0002 §12. Produce criterion-style benches for each stage + real-load harnesses for each stress scenario + a device matrix documenting pass/fail on representative GPUs. Land the CI perf-regression gate (> 10 % miss on p95 fails the PR). Canvas2D baselines re-measured on the same hardware for apples-to-apples comparison.

## 2. Phase

Phase E of RFC 0002 §17. Starts after EPIC-C exits (cells path stable) — may overlap EPIC-D (overlay benches slot in as D closes).

## 3. Duration

1 week.

## 4. Dependencies

- **EPIC-A exit**: `reportDiagnostics?` hook live; perf counters observable.
- **EPIC-B exit**: atlas benches established; those 4 benches are re-run here as part of the corpus.
- **EPIC-C exit**: cells pass produces parity frames; `DrawCallBudget` + frame instrumentation live.
- **EPIC-D**: overlay passes ready for stage measurement. May start E without D fully done (bench stubs with zero-overlay baseline).
- **RFC 0001 EPIC-J (telemetry)**: counter schema stable.

## 5. Scope

### 5.1 In

- Bench corpus: every stage in RFC 0002 §12 table has a `.bench.ts`.
- Real-load harnesses: `yes | head -10000`, keystroke-roundtrip, vim editing session, tmux pane resize, htop refresh, cold-start.
- Memory harness: 10 k × 120 scrollback RSS.
- Device matrix capture — Mac M-series, Intel Iris (MBP 2020), Intel Iris Windows, Apple M1 low-power, Android Chrome (gated lane).
- CI perf-regression gate: > 10 % p95 regression fails PR.
- Canvas2D re-baseline on same hardware for comparison tables.
- Perf report produced at `docs/plans/0002-webgl-renderer/perf-baseline-report.md`.
- Bench harness infrastructure: timer reliability (`performance.now` resolution), warmup-window discards, p50/p95/p99 statistics.

### 5.2 Out

- Rollout flag or fallback wiring — EPIC-F.
- Perf-cliff auto-fallback logic — EPIC-F (consumes these baselines).
- New bench for atlas — EPIC-B owns.
- New rendering features — EPIC-C and EPIC-D only.
- Any change to production runtime — benches are separate entry points.

## 6. Files

All new unless marked `updated`.

### 6.1 Stage benches

| File | Stage |
|------|-------|
| `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-hit.bench.ts` | Atlas hit (EPIC-B also owns; retuned here) |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-miss.bench.ts` | Atlas miss |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/blit.bench.ts` | Cell blit / instance upload |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/cursor-pass.bench.ts` | Cursor pass |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/overlay-pass.bench.ts` | Overlay pass |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-miss-recovery.bench.ts` | Atlas miss recovery (EPIC-B also owns) |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-rebuild.bench.ts` | Full atlas rebuild (EPIC-B also owns) |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/context-loss-recovery.bench.ts` | Context-loss → fallback |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/full-snapshot.bench.ts` | Full-snapshot fallback |
| `packages/ui/src/shared/ui/cell-renderer/__benches__/hit-test.bench.ts` | Layout / hit-test (unchanged from Canvas2D, re-run here) |
| `packages/ui/src/shared/lib/grid-mirror/__benches__/apply-delta.bench.ts` | Reducer / apply-delta (unchanged, re-run here for baseline freshness) |

### 6.2 Real-load harnesses

| File | Scenario |
|------|----------|
| `packages/ui/src/__tests__/perf/yes-head-10000.perf.ts` | `yes \| head -10000` sustained |
| `packages/ui/src/__tests__/perf/keystroke-roundtrip.perf.ts` | Keystroke → paint p95 |
| `packages/ui/src/__tests__/perf/vim-edit-session.perf.ts` | 5-min scripted vim session |
| `packages/ui/src/__tests__/perf/tmux-pane-resize.perf.ts` | Rapid pane resize |
| `packages/ui/src/__tests__/perf/htop-refresh.perf.ts` | 5-min htop refresh |
| `packages/ui/src/__tests__/perf/cold-start.perf.ts` | Mount → first paint |
| `packages/ui/src/__tests__/perf/memory-10k-scrollback.perf.ts` | RSS after 10k scrollback |
| `packages/ui/src/__tests__/perf/switch-backend-recovery.perf.ts` | Backend swap latency |

### 6.3 Infrastructure

| File | Purpose |
|------|---------|
| `packages/ui/src/__benches__/lib/bench-harness.ts` | Timer, warmup, stats (p50/p95/p99), outlier discard. |
| `packages/ui/src/__benches__/lib/load-fixtures.ts` | Golden PTY stream loading for perf harnesses. |
| `packages/ui/src/__benches__/lib/record-baseline.ts` | Write baseline JSON to `docs/plans/0002-webgl-renderer/perf-baselines/`. |
| `packages/ui/src/__benches__/lib/ci-gate.ts` | Compare run vs baseline; 10 % regression detection. |
| `docs/plans/0002-webgl-renderer/perf-baselines/m-series.json` | M-series Mac baselines. |
| `docs/plans/0002-webgl-renderer/perf-baselines/intel-iris.json` | Intel Iris baselines. |
| `docs/plans/0002-webgl-renderer/perf-baselines/intel-windows.json` | Intel Iris Windows baselines. |
| `docs/plans/0002-webgl-renderer/perf-baselines/README.md` | How baselines are updated. |
| `docs/plans/0002-webgl-renderer/device-matrix.md` | Human-readable pass/fail grid. |
| `docs/plans/0002-webgl-renderer/perf-baseline-report.md` | Narrative report with tables, charts refs. |
| `tools/ci/perf-gate.ts` | CI entry point; runs benches + compares + fails PR on regression. |

## 7. Definition of Done

### 7.1 Benches

- [ ] Every RFC 0002 §12 stage has a bench file at the path listed in the RFC.
- [ ] Each bench reports p50, p95, p99 over ≥ 1 000 iterations post-warmup.
- [ ] Warmup window: 100 iterations discarded.
- [ ] Outlier discard: IQR × 1.5 rule.
- [ ] `performance.now()` resolution verified ≥ 0.1 ms on target env; fallback to `Date.now()` + warning if coarser.
- [ ] Benches isolate stage under test (no DOM paint from other passes contaminating the measurement).
- [ ] Benches deterministic: same input → same relative timing distribution.

### 7.2 WebGL targets met

- [ ] Raster (atlas hit) p95 ≤ 0.4 ms on M-series.
- [ ] Raster (atlas miss) p95 ≤ 3.5 ms.
- [ ] Cell blit / instance upload p95 ≤ 0.8 ms.
- [ ] Cursor pass p95 ≤ 0.1 ms.
- [ ] Overlay pass p95 ≤ 0.2 ms.
- [ ] Atlas miss recovery p95 ≤ 4.0 ms.
- [ ] Font-atlas rebuild p95 ≤ 18.0 ms.
- [ ] Context-loss recovery p95 ≤ 14.0 ms.
- [ ] Full-snapshot fallback p95 ≤ 9.0 ms.

### 7.3 Real-load

- [ ] Cold start p95 ≤ 80 ms.
- [ ] Keystroke → paint p95 ≤ 8 ms.
- [ ] `yes | head -10000` sustained ≥ 120 fps on a 120 Hz display; 60 fps floor on 60 Hz.
- [ ] Memory ≤ 12 MB for 10 k × 120 scrollback.
- [ ] Idle CPU < 0.1 %.
- [ ] vim edit session: zero dropped frames over 5 minutes.
- [ ] tmux pane resize: every resize settles within 1 frame.
- [ ] htop refresh: sustained 60 fps for 5 minutes.

### 7.4 Device matrix

- [ ] M-series Mac (M1, M2, M3) — green.
- [ ] Intel Iris macOS (MBP 2020) — green OR auto-fallback (noted).
- [ ] Intel Iris Windows — green OR auto-fallback (noted).
- [ ] Apple M1 low-power mode — green.
- [ ] Android Chrome (WebGL2-required set) — green OR gated lane opt-in.
- [ ] iOS 15+ Safari — green OR auto-fallback.
- [ ] Per-device JSON baseline committed.
- [ ] `device-matrix.md` populated with pass/fail and notes.

### 7.5 CI gate

- [ ] `tools/ci/perf-gate.ts` runs benches on a tagged `@perf` CI lane.
- [ ] Compares against checked-in baseline JSON for the CI lane's hardware.
- [ ] > 10 % p95 regression fails PR.
- [ ] Regression report commented to PR with before/after numbers.
- [ ] Baselines updatable via a separate PR (`record-baseline.ts` script; requires manual review).

### 7.6 Canvas2D re-baseline

- [ ] Same benches run on Canvas2D backend on same hardware.
- [ ] Baselines recorded alongside WebGL.
- [ ] Comparison table in `perf-baseline-report.md` — stage × backend.

### 7.7 Reporting

- [ ] `perf-baseline-report.md` produced. Includes:
  - Device matrix.
  - Stage-by-stage Canvas2D vs WebGL comparison.
  - Real-load Canvas2D vs WebGL comparison.
  - Memory comparison.
  - Known regressions / device-specific fallback recommendations.
- [ ] Report cross-references RFC 0002 §4.1 stretch targets (all met or failure rationale).

### 7.8 General

- [ ] No production runtime change.
- [ ] `pnpm -F @quanta/ui test` green (non-perf tests unchanged).
- [ ] `pnpm -F @quanta/ui bench:all` runs every bench.
- [ ] `pnpm -F @quanta/ui perf:all` runs every real-load harness.
- [ ] CI lane documented in `.github/workflows/perf.yml` (new).
- [ ] `pnpm typecheck` green.
- [ ] `pnpm build` green.

## 8. Quality gates

- **Every RFC 0002 §12 target met on M-series** — hard gate. Failure = RFC acceptance gate §20 item blocked.
- **10 % regression CI gate** — enforced in PR flow.
- **Bench determinism** — same input → distributions within 5 % variance across runs.
- **Device matrix green or explicit fallback** — any red cell requires a recorded auto-fallback path.
- **No benchmark cheating** — benches test the actual backend code path, not a shortcut. Audit check in CI.
- **Canvas2D baseline captured on same hardware** — no cross-device comparisons.
- **Bench warmup correct** — first-iteration cost excluded; JIT-steady-state measured.

## 9. E2E tests

Perf-adjacent e2e scenarios — not benches but confirm harness correctness.

1. `packages/ui/src/__tests__/e2e/perf-harness-smoke.e2e.test.tsx` — runs `keystroke-roundtrip.perf.ts` with a tiny iteration count; asserts it exits cleanly and produces valid stats.
2. `packages/ui/src/__tests__/e2e/perf-baseline-regression.e2e.test.tsx` — feeds a synthetic slow implementation; asserts the CI gate fails.
3. `packages/ui/src/__tests__/e2e/perf-cold-start-budget.e2e.test.tsx` — cold mount; measures; asserts ≤ 80 ms.
4. `packages/ui/src/__tests__/e2e/perf-memory-budget.e2e.test.tsx` — 10 k scrollback simulation; measures RSS via `performance.memory` where available; asserts ≤ 12 MB.
5. `packages/ui/src/__tests__/e2e/perf-120fps.e2e.test.tsx` — `yes | head -10000` replay; measures per-frame time; asserts ≥ 120 fps on 120 Hz lane.
6. `packages/ui/src/__tests__/e2e/perf-canvas2d-parity.e2e.test.tsx` — runs both backends on the same workload; asserts WebGL ≤ Canvas2D across every stage.

## 10. Unit tests

- `bench-harness.test.ts` — timer reliability, stats math, outlier discard.
- `load-fixtures.test.ts` — fixture loading, format validation.
- `record-baseline.test.ts` — JSON schema, rounding, hash.
- `ci-gate.test.ts` — regression detection, 10 % rule, tie-breaker behavior.

## 11. Failure modes

- **Flaky benches** — CI lane is resource-isolated; 3-run median; outlier discard.
- **CI hardware drift** — baselines per CI runner; auto-refresh via scheduled re-baseline PR.
- **Memory measurement unreliable** — `performance.memory` is Chrome-only + approximate. Use node-inspected heap + `process.memoryUsage` in node lanes; for browser, accept ±20 % variance and raise threshold.
- **Integrated GPU cliff** — documented device matrix; auto-fallback (EPIC-F) covers at runtime.
- **120 Hz assertion fails on 60 Hz CI runner** — test gates on display refresh rate; emits skip on 60 Hz lanes; dedicated 120 Hz dev box for manual.
- **Warmup insufficient** — 100-iter warmup; shader JIT warms within 30 iters.
- **Bench measures wrong stage** — code review + stage isolation asserted.
- **Real-load harness leaks into next harness** — each harness mounts + unmounts.
- **Fixture PTY streams go stale** — fixture registry hash-tracked; CI fails on drift.
- **Baseline file accidentally overwritten** — `record-baseline.ts` refuses to overwrite without `--force`.
- **Perf-gate false positive** — IQR-aware comparison; 3 runs; 10 % threshold generous.
- **Cold-start measurement includes bundler time in dev** — harness runs in a production-built bundle.
- **Atlas warmup skews raster-miss bench** — raster-miss bench starts post-warmup.
- **`performance.now` quantized to 1 ms** — fallback mode + warning; p95 still meaningful.
- **No test for atlas page drop cost** — EPIC-B bench covers.
- **Overlay bench depends on EPIC-D ready** — start overlay bench AFTER EPIC-D lands; other benches proceed earlier.
- **Backend-switch latency bench untestable in CI** — switch-backend-recovery perf harness in headless Chrome.

## 12. Risks

- **Benchmark environment instability** — scheduling noise on shared CI. Mitigation: tagged `@perf` lane with isolated runner.
- **`performance.memory` deprecation** — Chrome may remove. Mitigation: document alternative + fallback.
- **Baseline file bloat in repo** — JSON per device; kept small (< 50 kB each); fine.
- **Android / iOS lanes hard to automate** — gated; manual + BrowserStack fallback.
- **Perf targets unreachable on specific GPU** — documented; EPIC-F auto-fallback handles runtime.
- **Cross-backend comparison misleads if Canvas2D re-baseline wasn't re-run on same HW** — enforced via a single-PR re-baseline rule.

## 13. Rollback

- Revert EPIC-E commits.
- Benches + harnesses + CI gate deleted.
- RFC 0002 §20 gate item "perf targets green" not satisfiable without this epic; WebGL ship blocked.
- EPIC-F can proceed with preset fallback thresholds hardcoded, but that's inferior; EPIC-E relanded quickly.

## 14. Cross-references

- **RFC 0001 §13.12** — base perf gate; WebGL tightens.
- **RFC 0001 §13.13** — stage decomposition schema; reused verbatim.
- **RFC 0001 §13.14** — counters consumed for perf-cliff detection.
- **RFC 0001 §18** — perf-harness testing strategy.
- **RFC 0002 §4.1** — stretch targets this epic proves.
- **RFC 0002 §12** — the §12 table is the DoD checklist.
- **RFC 0002 §13** — axis 2.
- **RFC 0002 §14 #7, #20** — owned failure modes.
- **RFC 0002 §20** — acceptance gate items §20-b + §20-d.
- **EPIC-B §6** — 4 atlas benches inherited.
- **EPIC-C §6** — draw-call counter + frame instrumentation used.
- **EPIC-D §16** — overlay pass bench slots.
- **EPIC-F §6** — perf-cliff detector consumes these baselines.

## 15. Day-by-day breakdown

### Day 1 — Infrastructure
- `bench-harness.ts` + `load-fixtures.ts` + `record-baseline.ts` + `ci-gate.ts`.
- Unit tests for each green.
- `pnpm -F @quanta/ui bench:all` script.

### Day 2 — Stage benches
- Port / author each stage bench.
- Run on M-series; record baselines.
- Verify every stage hits RFC 0002 §12 target.

### Day 3 — Real-load harnesses
- Author cold-start, keystroke-roundtrip, yes-head-10000, vim, tmux, htop.
- Run on M-series; record baselines.
- Verify stretch targets.

### Day 4 — Canvas2D re-baseline + comparison
- Re-run every bench on Canvas2D.
- Build comparison tables.
- Start `perf-baseline-report.md`.

### Day 5 — Device matrix
- Run on Intel Iris MBP + Intel Iris Windows.
- Run on Apple M1 low-power mode.
- Attempt Android Chrome + iOS 15 Safari (gated lanes).
- Document `device-matrix.md`.

### Day 6 — CI gate
- `.github/workflows/perf.yml` new workflow.
- `tools/ci/perf-gate.ts` entry.
- Test regression detection against deliberate slow change.
- Wire PR comment flow.

### Day 7 — Report + wrap
- `perf-baseline-report.md` complete.
- RFC 0002 §20 gate items §20-b + §20-d confirmed green.
- Notify EPIC-F owner that perf baselines are ready for fallback-threshold tuning.

## 16. Cross-epic handoffs

- **To EPIC-F**: perf baselines (`perf-baselines/*.json`) are the source of truth for perf-cliff detection thresholds. `frame_p95 > 2 × baseline sustained 5 s` uses these numbers.
- **To ADR 0019**: device matrix feeds the fallback matrix documentation.
- **To RFC 0002 §20 sign-off**: this epic closes §20 items "§12 perf targets green on M-series + Intel Iris".
