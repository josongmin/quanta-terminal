/**
 * Perf-budget definitions for Plan 0005 P0 Gate #7 + #10.
 *
 * Philosophy
 * ----------
 *  - A budget is a *hard ceiling* on a measured metric. If a perf test
 *    overshoots the ceiling, the test FAILS and CI blocks.
 *  - Because perf numbers are inherently noisy (GC pauses, OS preemption,
 *    jsdom overhead), we apply a two-tier tolerance: overshoots within
 *    10 % of the budget are reported as `warn` (no fail), overshoots
 *    beyond 10 % are `fail`. The runner tolerates `warn` but surfaces it
 *    in the pass/fail table so regressions are visible.
 *  - Budgets are expressed as absolute numbers — not ratios, not relative
 *    to some baseline. They match the user-visible targets in
 *    `docs/plans/0005-sota-convergence/test-strategy.md` §5.
 *
 * Units
 * -----
 *   `*Ms`  → milliseconds
 *   `*Us`  → microseconds
 *   `*Mb`  → mebibytes (1024²)
 *   `*Rows`→ rows of scrollback
 */

/**
 * Canonical budget set. Exported as a frozen object so tests reference a
 * single source of truth. Mutating this is a deliberate API change —
 * review the test-strategy doc first.
 *
 * Two families live here:
 *
 *   - **North-star targets** come from `test-strategy.md` §5.1 and
 *     describe the intended Rust-engine behaviour (feed P99 ≤ 16 ms,
 *     etc.). These are what CI ultimately asserts once the Rust engine
 *     lands.
 *   - **Current-impl budgets** are what the TypeScript reference
 *     emulator can actually hit on an Apple Silicon baseline with GC
 *     pressure. They're wider (the TS impl is ~10-30× slower on the
 *     tail than the Rust target) and they let us detect regressions
 *     against today's reality while the Rust work is in flight.
 *
 * The tests consume the current-impl values. The north-star values are
 * kept here as constants so the perf-harness runner can surface the
 * gap between "today" and "goal" in its report.
 */
export const PERF_BUDGETS = {
  /**
   * P99 latency of a single `VtEmulator.feed(chunk)` call on 1 KiB
   * input chunks (top/watch fixtures). The north-star is 16 ms (one
   * 60 Hz frame).
   *
   * Calibration (2026-04-21, Apple M4 Max, Node v25.9)
   * ---------------------------------------------------
   *   top-60s feed P99 median (3 runs)   : 29.2 ms
   *   watch-60s feed P99 median (3 runs) : 25.4 ms
   *   top-60s feed P99 noisy max         : 72 ms (background CPU contention)
   *
   * CI runs on shared Linux (ubuntu-24.04) which is ~2-3× slower than
   * Apple M4 Max on this workload. The enforced budget is set to 128 ms
   * = 4× the median — covers Linux × 3 + 20 % noise headroom. The
   * runner's 10 % WARN band surfaces drift before it hits FAIL.
   *
   * The north-star (16 ms) is retained in `feedLatencyP99MsTarget`
   * and will be enforced once the Rust engine replaces the TS
   * reference emulator.
   */
  feedLatencyP99Ms: 128,
  /**
   * North-star value retained for reference / reporting. Not used as
   * the assertion budget today. @see feedLatencyP99Ms.
   */
  feedLatencyP99MsTarget: 16,
  /** P99 render-tick latency (a full batcher flush cycle). Same
   *  reasoning as feed. North-star 16 ms; enforced 128 ms. */
  renderFrameBudgetP99Ms: 128,
  renderFrameBudgetP99MsTarget: 16,
  /** P99 keystroke-to-byte latency; measured by the input path, not
   *  reused here but kept in the budget catalogue for cross-reference. */
  keystrokeToByteLatencyP99Us: 2_000,
  /**
   * Mean duration of a single `emulator.resize()` call.
   * Measured 2026-04-21 Apple M4 Max median: 0.27 ms. Budget of 12 ms
   * ≈ 44× headroom which absorbs Linux CI + reflow-dominated workloads.
   */
  resizeDurationAvgMs: 12,
  /**
   * P99 duration of a single `emulator.resize()` call.
   * Measured 2026-04-21 Apple M4 Max median: 1.04 ms (noisy max 3.4 ms).
   * Budget of 32 ms ≈ 30× headroom; leaves plenty for Linux CI noise.
   */
  resizeDurationP99Ms: 32,
  /**
   * Maximum acceptable heapUsed delta during a `top`-like 60 s session
   * at 80×24. Measured 2026-04-21 Apple M4 Max: 17.44 MB (stable across
   * all runs). Budget 50 MB = ~3× measured, sized to catch leaky changes
   * while tolerating minor allocation-pattern drift. The original
   * scrollback-cap math (17 MB) is the steady-state floor.
   */
  topMemoryCeilingMb: 50,
  /** Maximum scrollback row count after a 1 GiB stress pour. Hard-bounded
   *  by `VtEmulator`'s scrollbackRows option; this assertion is the
   *  "ring really did evict" canary. */
  stressScrollbackCeilingRows: 10_000,
  /**
   * Per-chunk feed P99 for the `yes`-stress test (64 KiB chunks of
   * `y\n`). Calibrated 2026-04-21 on Apple M4 Max; observed P99 ≈ 2.25 s
   * per 64 KiB chunk because the TS emulator's scrollUp path clones the
   * full 24×80 grid on every LF — an O(bytes × rows × cols) hot path.
   * The budget is set to 10 000 ms = measured × ~4.4 = Apple-silicon
   * headroom (~1.2×) × Linux-CI-runner factor (~3×).
   *
   * The north-star Rust engine is expected to hit < 64 ms here; this
   * value will drop sharply once the Rust backend lands.
   */
  yesStreamFeedP99Ms: 10_000,
} as const;

export type PerfBudgetKey = keyof typeof PERF_BUDGETS;

/**
 * Linux CI budget profile (Plan 0005 P1-H).
 *
 * Background
 * ----------
 * `PERF_BUDGETS` above are calibrated on an Apple M4 Max workstation
 * running Node v25.9 with no background load. The GitHub
 * `ubuntu-24.04` runner — which is the only Linux image we pin in
 * `.github/workflows/perf-budget.yml` — delivers consistently 3-4×
 * slower wall-clock on these workloads because of:
 *
 *   - Shared vCPUs (2 vCPU on the standard runner, contention with
 *     other hosted jobs).
 *   - Slower memory bandwidth vs Apple Silicon's unified memory.
 *   - No AMX / NEON acceleration for the TS emulator's grid-clone
 *     hot path (`yes-1gb-budget` feels this the most).
 *
 * Rather than pay for a dedicated macOS runner (option B, rejected —
 * see §P1-H scope), we publish a second "ci-linux" profile that
 * widens every ceiling by a factor of 3. This still catches genuine
 * regressions (a doubled hot-path cost will still breach 3× budget)
 * while tolerating the runner's baseline cost.
 *
 * How profiles are selected
 * -------------------------
 * `tools/run-perf-budget.mjs` reads the `PERF_PROFILE` env var:
 *
 *   - `PERF_PROFILE=local`    → uses `PERF_BUDGETS` (default when unset).
 *   - `PERF_PROFILE=ci-linux` → uses `CI_LINUX_BUDGETS`.
 *
 * The workflow (`perf-budget.yml`) sets `PERF_PROFILE=ci-linux`.
 *
 * All multiplier-exempt fields (e.g. the `*Target` north-star values
 * and the hard `stressScrollbackCeilingRows` ring-buffer canary) keep
 * their local values. Those aren't runtime-sensitive.
 */
export const CI_LINUX_BUDGETS = {
  feedLatencyP99Ms: 384,
  feedLatencyP99MsTarget: 16,
  renderFrameBudgetP99Ms: 384,
  renderFrameBudgetP99MsTarget: 16,
  keystrokeToByteLatencyP99Us: 6_000,
  resizeDurationAvgMs: 36,
  resizeDurationP99Ms: 96,
  topMemoryCeilingMb: 150,
  stressScrollbackCeilingRows: 10_000,
  yesStreamFeedP99Ms: 30_000,
} as const;

/**
 * Profile identifiers understood by the runner. Keep this list in sync
 * with `resolveBudgets()` below.
 */
export type PerfProfile = 'local' | 'ci-linux';

/**
 * Resolve the budget set for a given profile. Falls back to `local`
 * for any unknown profile id so a misconfigured environment never
 * silently disables the budget.
 */
export function resolveBudgets(
  profile: PerfProfile | string | undefined,
): typeof PERF_BUDGETS | typeof CI_LINUX_BUDGETS {
  if (profile === 'ci-linux') return CI_LINUX_BUDGETS;
  return PERF_BUDGETS;
}

/**
 * Overshoot within this fraction of the budget is downgraded from `fail`
 * to `warn`. 0.10 = 10 %. Documented in the module header.
 */
export const BUDGET_WARN_TOLERANCE = 0.1;

/**
 * One timed sample. `feedStart` / `feedEnd` are `performance.now()`
 * readings in milliseconds. `chunkBytes` is the number of bytes fed on
 * that call — useful for bytes-per-ms throughput breakdowns when a perf
 * regression is being diagnosed.
 */
export interface PerfSample {
  readonly feedStart: number;
  readonly feedEnd: number;
  readonly chunkBytes: number;
}

/**
 * Summary statistics over a sample list. `count === 0` yields an all-zero
 * summary so callers can unconditionally format the output.
 */
export interface PerfSummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly totalMs: number;
  readonly totalBytes: number;
  /** Bytes per millisecond, calculated from totals. 0 when `totalMs === 0`. */
  readonly bytesPerMs: number;
}

/** Compute p50/p95/p99/max from a sample list. O(n log n); fine at our scale. */
export function summarize(samples: readonly PerfSample[]): PerfSummary {
  if (samples.length === 0) {
    return {
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
      totalMs: 0,
      totalBytes: 0,
      bytesPerMs: 0,
    };
  }
  const durations = samples.map((s) => s.feedEnd - s.feedStart);
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((acc, d) => acc + d, 0);
  const bytes = samples.reduce((acc, s) => acc + s.chunkBytes, 0);
  return {
    count: samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1]!,
    meanMs: total / samples.length,
    totalMs: total,
    totalBytes: bytes,
    bytesPerMs: total > 0 ? bytes / total : 0,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  // Nearest-rank method; matches the behaviour of most perf dashboards.
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx]!;
}

export type BudgetVerdict = 'pass' | 'warn' | 'fail';

/**
 * Decide pass/warn/fail for a measured value against a budget.
 * `actual <= budget` is a pass; `actual <= budget * (1 + tolerance)` is a
 * warn; otherwise fail.
 */
export function verdict(
  actual: number,
  budget: number,
  tolerance: number = BUDGET_WARN_TOLERANCE,
): BudgetVerdict {
  if (actual <= budget) return 'pass';
  if (actual <= budget * (1 + tolerance)) return 'warn';
  return 'fail';
}

/** Format a verdict for the CLI table. */
export function verdictLabel(v: BudgetVerdict): string {
  switch (v) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
  }
}
