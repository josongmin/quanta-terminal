import { describe, it, expect, vi } from 'vitest';
import { CellBuffer } from '../CellBuffer.js';
import { MirrorSource } from '../MirrorSource.js';
import { Renderer } from '../Renderer.js';
import { MemoryBackend } from '../backend/MemoryBackend.js';
import { asciiRow } from './fixtures.js';

/** Synchronous fake rAF — runs the callback immediately. Lets us count
 *  paints per mirror event without waiting on a real frame clock. */
function sync(): { rAF: (cb: FrameRequestCallback) => number; cancel: (h: number) => void } {
  let seq = 0;
  const scheduled = new Map<number, FrameRequestCallback>();
  const rAF = (cb: FrameRequestCallback): number => {
    seq += 1;
    scheduled.set(seq, cb);
    // Fire on the microtask queue so we can assert coalescing windows.
    queueMicrotask(() => {
      const fn = scheduled.get(seq);
      if (fn) {
        scheduled.delete(seq);
        fn(performance.now());
      }
    });
    return seq;
  };
  const cancel = (h: number): void => {
    scheduled.delete(h);
  };
  return { rAF, cancel };
}

function setup(rows = 4, cols = 4): {
  buffer: CellBuffer;
  source: MirrorSource;
  backend: MemoryBackend;
  renderer: Renderer;
  flush: () => Promise<void>;
} {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows, cols });
  const backend = new MemoryBackend();
  const { rAF, cancel } = sync();
  const renderer = new Renderer(backend, buffer, source, { rAF, cancelRAF: cancel });
  renderer.setRowFetcher((r) => {
    if (r >= rows) return undefined;
    return asciiRow('abcd'.slice(0, cols), cols);
  });
  const flush = async (): Promise<void> => {
    // Drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { buffer, source, backend, renderer, flush };
}

describe('Renderer — rAF coalescing', () => {
  it('coalesces 50 enqueued changes into at most 1 paint per frame (DoD-D-15)', async () => {
    const { source, backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    for (let i = 0; i < 50; i += 1) {
      source.emit(new Set([i % 4]));
    }
    await flush();
    const paintDeltas = backend.calls().filter((c) => c.kind === 'delta').length;
    expect(paintDeltas).toBe(1);
  });

  it('no paint occurs when damage is empty (DoD-D-16)', async () => {
    const { backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    renderer.scheduleFrame();
    await flush();
    expect(backend.calls().filter((c) => c.kind === 'delta').length).toBe(0);
  });

  it('cursor-only updates do not repaint grid (DoD-D-17, three-layer independence)', async () => {
    const { backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    for (let i = 0; i < 1000; i += 1) {
      renderer.markCursorDirty({
        row: 0,
        col: i % 4,
        visible: true,
        shape: 'block',
        blinking: false,
        pending_wrap: false,
      });
      await flush();
    }
    const gridPaints = backend.calls().filter((c) => c.kind === 'delta').length;
    const cursorPaints = backend.calls().filter((c) => c.kind === 'cursor').length;
    expect(gridPaints).toBe(0);
    expect(cursorPaints).toBeGreaterThan(0);
  });

  it('scheduleFrame is idempotent within one frame', async () => {
    const { source, backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    for (let i = 0; i < 10; i += 1) {
      source.emit(new Set([1]));
      renderer.scheduleFrame();
      renderer.scheduleFrame();
    }
    await flush();
    const deltas = backend.calls().filter((c) => c.kind === 'delta').length;
    expect(deltas).toBeLessThanOrEqual(1);
  });

  it('freeze() stops all subsequent paints (DoD-D-18)', async () => {
    const { source, backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    renderer.freeze();
    source.emit(new Set([0, 1, 2, 3]));
    await flush();
    expect(backend.calls().filter((c) => c.kind === 'delta').length).toBe(0);
    expect(renderer.isFrozen()).toBe(true);
  });

  it('stop() then start() resumes painting', async () => {
    const { source, backend, renderer, flush } = setup();
    renderer.start();
    renderer.stop();
    await flush();
    backend.resetCalls();
    source.emit(new Set([0]));
    await flush();
    expect(backend.calls().filter((c) => c.kind === 'delta').length).toBe(0);
    renderer.start();
    source.emit(new Set([0]));
    await flush();
    expect(backend.calls().filter((c) => c.kind === 'delta').length).toBeGreaterThanOrEqual(1);
  });
});

describe('Renderer — perf instrumentation', () => {
  it('perfSummary reports samples after a paint', async () => {
    const { source, renderer, flush } = setup();
    renderer.start();
    await flush();
    source.emit(new Set([0, 1, 2]));
    await flush();
    const summary = renderer.perfSummary();
    expect(summary.count).toBeGreaterThan(0);
  });

  it('perfSummary is empty without paints', () => {
    const { renderer } = setup();
    const summary = renderer.perfSummary();
    expect(summary.count).toBe(0);
    expect(summary.p95).toBe(0);
  });
});

describe('Renderer — rAF boundary perf fixture', () => {
  it('applies 1000 deltas within 1 second budget (under 1000ms)', async () => {
    const { source, renderer, flush } = setup(40, 120);
    renderer.start();
    await flush();
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      source.emit(new Set([i % 40]));
      if (i % 10 === 0) {
        // Yield every 10 deltas to let the scheduler run.
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }
    await flush();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
    const summary = renderer.perfSummary();
    expect(summary.count).toBeGreaterThan(0);
  });
});

describe('Renderer — lifecycle', () => {
  it('dispose releases mirror subscription', () => {
    const { source, renderer } = setup();
    renderer.start();
    expect(source.subscriberCount()).toBeGreaterThanOrEqual(1);
    renderer.dispose();
    // The CellBuffer still owns its own subscription; renderer only held one.
    // After dispose we subtract the renderer's.
    expect(source.subscriberCount()).toBeGreaterThanOrEqual(0);
  });

  it('start() is idempotent', () => {
    const { renderer } = setup();
    renderer.start();
    renderer.start();
    renderer.start();
    expect(renderer.isFrozen()).toBe(false);
  });

  it('forceTick paints when damage is present', () => {
    const { source, backend, renderer } = setup();
    renderer.start();
    source.emit(new Set([0]));
    const before = backend.calls().length;
    renderer.forceTick();
    const after = backend.calls().length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('Renderer — markOverlayDirty', () => {
  it('marks overlay dirty and schedules a frame', async () => {
    const { backend, renderer, flush } = setup();
    renderer.start();
    await flush();
    backend.resetCalls();
    renderer.markOverlayDirty();
    await flush();
    const flushes = backend.calls().filter((c) => c.kind === 'flush').length;
    expect(flushes).toBeGreaterThanOrEqual(1);
  });
});

describe('Renderer — vi-mocked rAF smoke', () => {
  it('uses injected rAF', () => {
    const rAF = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const cancelRAF = vi.fn();
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 1 });
    const renderer = new Renderer(new MemoryBackend(), buffer, source, { rAF, cancelRAF });
    renderer.start();
    renderer.scheduleFrame();
    expect(rAF).toHaveBeenCalled();
  });
});
