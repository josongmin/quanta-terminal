/**
 * C-MON-01 perf gate (Plan 0005 P0 Gate #7).
 *
 * Simulates a 60-second `top` session by looping the C-MON-01 compat
 * fixture through the real `VtEmulator` via the frame-skip batcher.
 *
 * Why this test matters
 * ---------------------
 *  - `top` is the prototypical full-screen TUI: alt-buffer paints every
 *    second, column-reflow on resize, status line SGR. If feed latency
 *    blows its budget here, real-world TUI workloads will stutter.
 *  - We measure heap growth across the window — scrollback must evict
 *    aggressively on main-buffer transitions, and alt-buffer paints
 *    must NOT enter scrollback at all (the compat test already proves
 *    the invariant; this one proves the residency consequences).
 *
 * Budget (from `perf-budget.ts`):
 *    feed P99 ≤ 16 ms, render P99 ≤ 16 ms, heap delta ≤ 150 MB,
 *    dropped bytes === 0.
 *
 * Fake-time methodology
 * ---------------------
 *  - Vitest's fake timers advance `setTimeout` but NOT `performance.now()`
 *    when we measure feed latency — which is exactly what we want.
 *    Each feed is a real CPU-bound call; only the scheduler between
 *    batches is synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VtEmulator } from '../../shared/lib/vt-emulator/VtEmulator.js';
import { createFrameSkipBatcher } from '../../shared/lib/write-batcher-frame-skip.js';

import {
  PERF_BUDGETS,
  summarize,
  verdict,
  type PerfSample,
} from './perf-budget.js';
import {
  createManualScheduler,
  drainScheduler,
  memorySnapshot,
  silentEnvelopeSink,
  sliceChunks,
  topFrames,
} from './perf-fixtures.js';

/** 60 s at 1 Hz `top` ticks = 60 frames × 3 (fixture has 3-frame loop).
 *  We double the frame count so warmup iterations can be discarded and
 *  we still have a statistically meaningful steady-state sample window. */
const SIMULATED_FRAMES = 180;
/**
 * 1 KiB feed granularity mirrors a real PTY `read()` much more closely
 * than a single megabyte-scale flush would. With ~0.5 MB of fixture
 * data this gives ~500 samples, which is enough to make the P99 stable
 * at the ms scale.
 */
const CHUNK_BYTES = 1024;
/** First-N feeds are excluded from the latency histogram so we measure
 *  steady-state, not JIT-warmup. */
const WARMUP_CHUNKS = 20;

describe('perf: C-MON-01 top 60s budget', () => {
  let stream: Uint8Array;

  beforeAll(async () => {
    stream = await topFrames(SIMULATED_FRAMES);
  });

  afterAll(() => {
    // Drop the fixture reference so the post-test heap read isn't
    // inflated by holding the multi-MB buffer in module scope.
    stream = new Uint8Array(0);
  });

  it('feeds 60 s of top output within budget', () => {
    const emulator = new VtEmulator({
      sessionId: 'perf-top-60s',
      rows: 24,
      cols: 80,
      onEnvelope: silentEnvelopeSink(),
    });

    const sched = createManualScheduler();
    const samples: PerfSample[] = [];
    const renderSamples: PerfSample[] = [];
    let fedIndex = 0;

    const batcher = createFrameSkipBatcher({
      write: (data) => {
        const t0 = performance.now();
        emulator.feed(data);
        const t1 = performance.now();
        // Discard the first WARMUP_CHUNKS feeds to avoid JIT/cold-cache
        // skew dominating the histogram.
        if (fedIndex >= WARMUP_CHUNKS) {
          samples.push({ feedStart: t0, feedEnd: t1, chunkBytes: data.byteLength });
        }
        fedIndex += 1;
      },
      scheduler: sched.schedule,
      cancelScheduler: sched.cancel,
      // Force emergency drop only on true hardCap violation — for a
      // 60s top session the queue should never approach this.
      hardCapBytes: 512 * 1024 * 1024,
    });

    const chunks = sliceChunks(stream, CHUNK_BYTES);
    // Simulate a 1 Hz cadence: enqueue one chunk per "frame", then drain
    // the batcher. This mirrors the way a real PTY feeds data in small
    // bursts rather than one giant blob.
    let chunkIdx = 0;
    const beforeIdx = WARMUP_CHUNKS;
    let before = memorySnapshot(true);
    for (const chunk of chunks) {
      if (chunkIdx === beforeIdx) {
        before = memorySnapshot(true);
      }
      const r0 = performance.now();
      batcher.enqueue(chunk);
      drainScheduler(sched);
      const r1 = performance.now();
      if (chunkIdx >= WARMUP_CHUNKS) {
        renderSamples.push({
          feedStart: r0,
          feedEnd: r1,
          chunkBytes: chunk.byteLength,
        });
      }
      chunkIdx += 1;
    }
    // Flush any residual queue (fixture tail that didn't end on a safe boundary).
    batcher.flush();
    drainScheduler(sched);

    const after = memorySnapshot(true);

    const feed = summarize(samples);
    const render = summarize(renderSamples);

    const stats = batcher.stats();
    // Byte-accounting invariant: every byte enqueued must either be
    // written to the emulator or counted as an emergency drop.
    expect(stats.bytesInTotal).toBe(
      stats.bytesOutTotal + stats.emergencyDroppedBytesTotal,
    );
    expect(emulator.feedBytesTotal).toBe(stats.bytesOutTotal);
    expect(stats.emergencyDroppedBytesTotal).toBe(0);

    const heapDeltaMb = after.heapUsedMb - before.heapUsedMb;
    const report = {
      fixture: 'C-MON-01',
      simulatedSeconds: SIMULATED_FRAMES,
      samples: feed.count,
      feedP50Ms: round(feed.p50Ms),
      feedP95Ms: round(feed.p95Ms),
      feedP99Ms: round(feed.p99Ms),
      feedMaxMs: round(feed.maxMs),
      renderP99Ms: round(render.p99Ms),
      heapDeltaMb: round(heapDeltaMb),
      bytesFedMb: round(stats.bytesOutTotal / (1024 * 1024)),
      droppedBytes: stats.emergencyDroppedBytesTotal,
      frameSkips: stats.frameSkipCount,
    };
    // eslint-disable-next-line no-console
    console.log('[perf:top-60s]', JSON.stringify(report));

    const feedVerdict = verdict(feed.p99Ms, PERF_BUDGETS.feedLatencyP99Ms);
    const renderVerdict = verdict(
      render.p99Ms,
      PERF_BUDGETS.renderFrameBudgetP99Ms,
    );
    const memVerdict = verdict(heapDeltaMb, PERF_BUDGETS.topMemoryCeilingMb);

    expect(feedVerdict, `feed p99=${feed.p99Ms}ms`).not.toBe('fail');
    expect(renderVerdict, `render p99=${render.p99Ms}ms`).not.toBe('fail');
    expect(memVerdict, `heap delta=${heapDeltaMb}MB`).not.toBe('fail');
    expect(stats.emergencyDroppedBytesTotal).toBe(0);

    batcher.dispose();
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
