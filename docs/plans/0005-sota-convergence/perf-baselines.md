# Plan 0005 — Perf Baselines

- **Date**: 2026-04-21
- **Machine**: Darwin Joui-MacBookPro.local 24.6.0 Darwin Kernel Version 24.6.0: Mon Jul 14 11:30:40 PDT 2025; root:xnu-11417.140.69~1/RELEASE_ARM64_T6041 arm64
- **CPU**: Apple M4 Max
- **Node**: v25.9.0
- **Vitest**: 2.1.9
- **Reference commit**: f74c047 (perf harness scaffold), calibrated on this branch

## Why this doc exists

Plan 0005 P0 Gate #7 requires a JS-side perf-budget harness that actually
runs end-to-end and has CI-defensible thresholds. Without calibrated
baselines the budgets in `packages/ui/src/__tests__/perf/perf-budget.ts`
were copy-pasted from the test-strategy north-star, which is sized for
the future Rust engine — not the TypeScript reference `VtEmulator` that
runs today. Several budgets were either too loose to catch regressions
(150 MB memory ceiling vs 17 MB actual) or fundamentally infeasible
(1 GiB `yes` pour vs 2 MiB running in 60 s).

This file captures the measured reality and the rationale for each
enforced budget.

## Methodology

- Harness: `tools/run-perf-budget.mjs` invokes each spec as an isolated
  `vitest run` with `VITEST_PERF=1`, `NODE_OPTIONS=--expose-gc`. JSON
  metrics are written to `artifacts/perf/<iso-timestamp>.json`.
- Test framework: Vitest 2.1.9, jsdom environment, fake timers for
  scheduler-driven tests.
- Each fixture ran 3× back-to-back (after killing stale vitest workers
  from other worktrees); median judges. A fourth "noisy" run was taken
  with background CPU contention to size the budget headroom.
- Feed-latency samples: `performance.now()` readings on each
  `VtEmulator.feed(chunk)` call. First 20 chunks discarded as warmup.
- Memory: `process.memoryUsage().heapUsed` delta across the test window
  (before/after `global.gc()`). RSS not captured — see "Hardware caveats"
  below.
- `yes-1gb` spec was re-scoped from 1 GiB → 2 MiB (see Findings) because
  at 1 GiB the TS emulator cannot complete inside any reasonable CI
  budget. The test's invariants (scrollback eviction, byte accounting,
  per-chunk feed P99) are scale-invariant and hold at the smaller size.

## Measurements

Three clean runs (all background vitest processes killed first), then
one "contended" run to probe noise headroom. Numbers are **per single
`feed()` call** on 1 KiB (top/watch) or 64 KiB (yes) chunks.

| Fixture | Median P50 feed | Median P95 feed | Median P99 feed | Noisy max P99 | Peak heap delta (MB) | Duration (s) |
|---|---|---|---|---|---|---|
| top-60s | 1.07 ms | 12.6 ms | 29.2 ms | 71.9 ms | 17.44 | 1.7 – 3.6 |
| watch-60s | 1.10 ms | 2.01 ms | 25.4 ms | 48.7 ms | 0.55 | 1.3 – 3.2 |
| yes-stress (64 KiB × 32) | 1648 ms | 2198 ms | 2008 ms | 3525 ms | ≈381 | 47 – 85 |
| resize-cycle (100×) | 0.22 ms | 0.35 ms | 1.04 ms | 6.85 ms | n/a | ~1.2 |

### Why the `yes` numbers are in **seconds**, not milliseconds

`VtEmulator.scrollUpRegion()` clones every row above the cursor on every
LF (`src.map((c) => ({ ...c }))`, see `VtEmulator.ts:1519-1521`). For a
24×80 grid that's ≈1 920 cell-object allocations per newline. A 64 KiB
`yes` chunk has ≈32 000 LFs ⇒ ≈61 M cell clones per feed. On Apple M4
Max we measure ≈40 ns per clone ⇒ ≈2 s per chunk. A literal 1 GiB pour
(the north-star target) would take over an hour on the TS reference
impl — infeasible as a CI gate. The Rust engine is expected to drop
this figure by 3+ orders of magnitude; once it lands, the scope in
`yes-1gb-budget.test.ts` will be restored to 1 GiB.

## Recommended CI budgets (committed in `perf-budget.ts`)

| Metric | Measured (M4 Max median) | Budget | Multiplier | Rationale |
|---|---|---|---|---|
| `feedLatencyP99Ms` | 29.2 ms (top), 25.4 ms (watch) | **128 ms** | ≈4.4× | Absorbs Apple→Linux slowdown (~2-3×) + 20% noise headroom. Still well under the 250 ms user-pleasant threshold. |
| `renderFrameBudgetP99Ms` | 29.2 ms | **128 ms** | ≈4.4× | Same reasoning; render and feed are serialized in the frame-skip batcher. |
| `resizeDurationAvgMs` | 0.27 ms | **12 ms** | ≈44× | Noisy (6.85 ms noisy max); 12 ms is intentional generous headroom and matches the north-star. |
| `resizeDurationP99Ms` | 1.04 ms | **32 ms** | ≈30× | Covers drag-induced resize bursts on noisy CI. |
| `topMemoryCeilingMb` | 17.44 MB (stable across 3 runs) | **50 MB** | ≈3× | Tight enough to catch leaks; 150 MB → 50 MB was the largest change. |
| `yesStreamFeedP99Ms` | 2008 ms | **10 000 ms** | ≈5× | Linux CI + GC variance on a workload dominated by V8 allocator rate. |
| `stressScrollbackCeilingRows` | 10 000 (cap, not a measurement) | **10 000** | 1× | Hard cap; assertion verifies the ring didn't leak past its configured size. |
| `feedLatencyP99MsTarget` (north-star) | — | 16 ms | — | Retained for reporting. Enforced once the Rust engine lands. |

### What changed vs the pre-calibration scaffold

| Budget | Before (scaffold) | After (calibrated) | Direction | Why |
|---|---|---|---|---|
| `feedLatencyP99Ms` | 64 | 128 | Loosened | 64 ms was 2.2× the median — one GC pause hit FAIL in contended runs. |
| `renderFrameBudgetP99Ms` | 64 | 128 | Loosened | Same. |
| `topMemoryCeilingMb` | 150 | 50 | Tightened | 150 was 8.6× the observed 17.4 MB — regressions would go unnoticed. |
| `yesStreamFeedP99Ms` | (none — reused 64 ms `feedLatencyP99Ms`) | 10 000 | New | Previous reuse was nonsense; the `yes` feed is in seconds on TS. |
| (test constant) `TOTAL_BYTES` | 1 GiB | 2 MiB | Shrunk | 1 GiB is infeasible on the TS emulator; invariants hold at any size ≥ 1 × scrollback cap. |

## Flake policy

- **Retry**: CI runs the harness up to 3×. If ≥ 2 of 3 attempts PASS,
  the job passes (majority judge). See `.github/workflows/perf-budget.yml`.
- **Warn band**: the runner reports `WARN` for overshoots within 10 % of
  the budget. WARN does not fail the spec; it's surfaced in the
  PASS/WARN/FAIL table for trend-watching.
- **Fail band**: overshoots beyond 10 % fail the spec. On failure the
  full `artifacts/perf/<timestamp>.json` is uploaded for triage.
- **Single runner**: CI pins `ubuntu-24.04` to keep hardware drift small.
  Apple Silicon is not in the matrix — the Rust criterion benches
  (`perf.yml`) cover that signal.

## Hardware caveats

- Apple M4 Max runs this workload roughly **2-3× faster** than a
  `ubuntu-24.04` shared CI runner. The enforced budgets are
  Linux-calibrated, which is why local-dev measurements will look
  generously under-budget.
- `heapUsed` is **not RSS**. External TypedArray backing stores and
  jsdom's native memory are invisible to this metric. A regression that
  leaks into `rss` but not `heapUsed` will go undetected by this
  harness — the scrollback bound + byte-accounting invariants in
  `yes-1gb-budget.test.ts` are our belt-and-braces proof that the ring
  actually evicts.
- Running without `--expose-gc` makes the `yes-1gb` heap delta look
  ≈30 % higher because the before/after snapshots don't share a GC
  baseline. `tools/run-perf-budget.mjs` always forwards `--expose-gc` to
  the vitest child.
- Vitest worker pool contention (running multiple perf specs
  concurrently, or other vitest instances in adjacent worktrees) can
  double the feed P99. The runner enforces serial execution
  (one spec per spawned vitest) but cannot guard against parallel
  worktrees; local reruns after `pkill -f vitest` showed ≈ 2× the clean
  numbers when contended. This is another reason for the 4.4× budget
  multiplier on `feedLatencyP99Ms`.

## Follow-ups

- Restore `yes-1gb-budget.test.ts` TOTAL_BYTES to 1 GiB (and
  `yesStreamFeedP99Ms` to the north-star 16 ms ceiling) once the Rust
  engine replaces `VtEmulator`. Tracked under Plan 0005 Epic-Rust.
- Consider adding an RSS ceiling alongside `topMemoryCeilingMb` once we
  have a cross-platform RSS probe; right now `process.memoryUsage().rss`
  readings under jsdom are unreliable.
- When Linux CI hardware drifts (e.g. GitHub adds ubuntu-26.04), re-run
  the 3-of-3 baseline procedure here and update this document. The
  budgets themselves should only be tightened as the engine improves —
  never loosened without a recorded reason.
