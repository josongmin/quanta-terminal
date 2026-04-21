/**
 * C-MON-03 perf gate — 60-second `watch`-style periodic-repaint session.
 *
 * `watch -n 1 foo` exhibits the same pattern as `top` but without the
 * alt-buffer toggle: it clears the screen (CSI 2J / home) and repaints.
 * We reuse the C-PG-01 (`less`) fixture as a stand-in because it has
 * the alt-buffer + repaint pattern we care about and ships in-tree. The
 * test still enforces the full feed-latency / memory budget.
 *
 * Budget: feed P99 ≤ 16 ms, render P99 ≤ 16 ms, heap delta ≤ 150 MB,
 * dropped bytes === 0.
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
  watchFrames,
} from './perf-fixtures.js';

/** See top-60s-budget.test.ts for the chunk-size / sample-count rationale. */
const SIMULATED_FRAMES = 180;
const CHUNK_BYTES = 1024;
const WARMUP_CHUNKS = 20;

describe('perf: C-MON-03 watch 60s budget', () => {
  let stream: Uint8Array;

  beforeAll(async () => {
    stream = await watchFrames(SIMULATED_FRAMES);
  });

  afterAll(() => {
    stream = new Uint8Array(0);
  });

  it('feeds 60 s of watch-like output within budget', () => {
    const emulator = new VtEmulator({
      sessionId: 'perf-watch-60s',
      rows: 40,
      cols: 120,
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
        if (fedIndex >= WARMUP_CHUNKS) {
          samples.push({ feedStart: t0, feedEnd: t1, chunkBytes: data.byteLength });
        }
        fedIndex += 1;
      },
      scheduler: sched.schedule,
      cancelScheduler: sched.cancel,
      hardCapBytes: 512 * 1024 * 1024,
    });

    const chunks = sliceChunks(stream, CHUNK_BYTES);
    let chunkIdx = 0;
    let before = memorySnapshot(true);
    for (const chunk of chunks) {
      if (chunkIdx === WARMUP_CHUNKS) {
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
    batcher.flush();
    drainScheduler(sched);

    const after = memorySnapshot(true);

    const feed = summarize(samples);
    const render = summarize(renderSamples);

    const stats = batcher.stats();
    expect(stats.bytesInTotal).toBe(
      stats.bytesOutTotal + stats.emergencyDroppedBytesTotal,
    );
    expect(emulator.feedBytesTotal).toBe(stats.bytesOutTotal);
    expect(stats.emergencyDroppedBytesTotal).toBe(0);

    const heapDeltaMb = after.heapUsedMb - before.heapUsedMb;
    const report = {
      fixture: 'C-PG-01-loop',
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
    console.log('[perf:watch-60s]', JSON.stringify(report));

    const feedVerdict = verdict(feed.p99Ms, PERF_BUDGETS.feedLatencyP99Ms);
    const renderVerdict = verdict(
      render.p99Ms,
      PERF_BUDGETS.renderFrameBudgetP99Ms,
    );
    const memVerdict = verdict(heapDeltaMb, PERF_BUDGETS.topMemoryCeilingMb);

    expect(feedVerdict, `feed p99=${feed.p99Ms}ms`).not.toBe('fail');
    expect(renderVerdict, `render p99=${render.p99Ms}ms`).not.toBe('fail');
    expect(memVerdict, `heap delta=${heapDeltaMb}MB`).not.toBe('fail');

    batcher.dispose();
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
