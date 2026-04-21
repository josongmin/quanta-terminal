/**
 * C-UX-02 perf gate — resize cycles.
 *
 * Ripples a VtEmulator between two screen shapes (80×24 ↔ 120×40) 100
 * times and asserts:
 *   - each individual resize stays under 16 ms
 *   - the mean resize stays under 12 ms
 *
 * Rationale
 * ---------
 *  - Users frequently drag the window, firing SIGWINCH repeatedly over
 *    a single second. If a resize takes >16 ms, the window feels
 *    "sticky" to the drag.
 *  - The emulator reflows the main buffer and re-allocates the alt
 *    buffer on every resize. That's a hot-path budget.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../../shared/lib/vt-emulator/VtEmulator.js';

import {
  PERF_BUDGETS,
  summarize,
  verdict,
  type PerfSample,
} from './perf-budget.js';
import { silentEnvelopeSink } from './perf-fixtures.js';

const CYCLES = 100;

describe('perf: C-UX-02 resize cycle budget', () => {
  it('stays within per-resize and average budgets', () => {
    const emulator = new VtEmulator({
      sessionId: 'perf-resize',
      rows: 24,
      cols: 80,
      onEnvelope: silentEnvelopeSink(),
    });

    // Pre-fill the main buffer with enough text that reflow actually
    // does work on each resize. Without this the resize path is
    // dominated by grid allocation and we'd under-report the budget.
    const warmup = new TextEncoder().encode(
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n'.repeat(200),
    );
    emulator.feed(warmup);

    const samples: PerfSample[] = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const [rows, cols] = i % 2 === 0 ? [40, 120] : [24, 80];
      const t0 = performance.now();
      emulator.resize(rows, cols);
      const t1 = performance.now();
      samples.push({ feedStart: t0, feedEnd: t1, chunkBytes: 0 });
    }

    const s = summarize(samples);
    const report = {
      cycles: CYCLES,
      avgMs: round(s.meanMs),
      p50Ms: round(s.p50Ms),
      p95Ms: round(s.p95Ms),
      p99Ms: round(s.p99Ms),
      maxMs: round(s.maxMs),
    };
    // eslint-disable-next-line no-console
    console.log('[perf:resize-cycle]', JSON.stringify(report));

    const avgVerdict = verdict(s.meanMs, PERF_BUDGETS.resizeDurationAvgMs);
    const p99Verdict = verdict(s.p99Ms, PERF_BUDGETS.resizeDurationP99Ms);

    expect(avgVerdict, `avg=${s.meanMs}ms`).not.toBe('fail');
    expect(p99Verdict, `p99=${s.p99Ms}ms`).not.toBe('fail');
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
