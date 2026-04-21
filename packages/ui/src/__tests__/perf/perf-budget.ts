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
   * input chunks. The north-star is 16 ms (one 60 Hz frame). The
   * current TS implementation regularly sees GC-pause-driven tail
   * spikes to ~40 ms, so the enforced budget is 64 ms — 4× the
   * north-star, which the runner's WARN band (10 %) still catches
   * when regressing.
   */
  feedLatencyP99Ms: 64,
  /**
   * North-star value retained for reference / reporting. Not used as
   * the assertion budget today. @see feedLatencyP99Ms.
   */
  feedLatencyP99MsTarget: 16,
  /** P99 render-tick latency (a full batcher flush cycle). Same
   *  reasoning as feed. North-star 16 ms; enforced 64 ms. */
  renderFrameBudgetP99Ms: 64,
  renderFrameBudgetP99MsTarget: 16,
  /** P99 keystroke-to-byte latency; measured by the input path, not
   *  reused here but kept in the budget catalogue for cross-reference. */
  keystrokeToByteLatencyP99Us: 2_000,
  /** Mean duration of a single `emulator.resize()` call. North-star
   *  12 ms; the TS impl comfortably hits this today. */
  resizeDurationAvgMs: 12,
  /** P99 duration of a single `emulator.resize()` call. */
  resizeDurationP99Ms: 32,
  /** Maximum acceptable heapUsed delta during a `top`-like 60 s session
   *  at 80×24. Based on scrollback cap math (~17 MB) + working-set
   *  headroom. */
  topMemoryCeilingMb: 150,
  /** Maximum scrollback row count after a 1 GiB stress pour. Hard-bounded
   *  by `VtEmulator`'s scrollbackRows option; this assertion is the
   *  "ring really did evict" canary. */
  stressScrollbackCeilingRows: 10_000,
} as const;

export type PerfBudgetKey = keyof typeof PERF_BUDGETS;

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
