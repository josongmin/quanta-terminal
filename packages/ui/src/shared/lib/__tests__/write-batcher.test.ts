import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteBatcher } from '../write-batcher.js';

interface ManualScheduler {
  schedule: (cb: () => void) => number;
  cancel: (id: number) => void;
  tick: () => void;
  pending: number;
}

function makeManualScheduler(): ManualScheduler {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    schedule: (cb) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, cb);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
    tick: () => {
      // Copy to array so callbacks scheduling new work during flush don't
      // re-execute in the same tick.
      const snapshot = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, cb] of snapshot) cb();
    },
    get pending() {
      return callbacks.size;
    },
  };
}

describe('createWriteBatcher', () => {
  let ticker: ManualScheduler;
  let writes: Uint8Array[];

  beforeEach(() => {
    ticker = makeManualScheduler();
    writes = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('batches 1000 small chunks into ONE write per frame', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });

    const payload = new Uint8Array([0x41]); // 'A'
    for (let i = 0; i < 1000; i += 1) batcher.enqueue(payload);

    expect(writes.length).toBe(0); // nothing written until the frame fires
    expect(batcher.queuedBytes).toBe(1000);
    expect(ticker.pending).toBe(1);

    ticker.tick();

    expect(writes.length).toBe(1);
    expect(writes[0]!.byteLength).toBe(1000);
    expect(batcher.flushCount).toBe(1);
    expect(batcher.queuedBytes).toBe(0);
  });

  it('concatenates chunks in arrival order', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    batcher.enqueue(new Uint8Array([1, 2]));
    batcher.enqueue(new Uint8Array([3]));
    batcher.enqueue(new Uint8Array([4, 5, 6]));
    ticker.tick();
    expect(Array.from(writes[0]!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips the copy when only one chunk is queued', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    const chunk = new Uint8Array([9, 9, 9]);
    batcher.enqueue(chunk);
    ticker.tick();
    // Identity check: single-chunk flush passes the original reference.
    expect(writes[0]).toBe(chunk);
  });

  it('flushes eagerly when the queue exceeds the soft cap', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      flushBytesThreshold: 16,
    });
    batcher.enqueue(new Uint8Array(10));
    expect(writes.length).toBe(0);
    batcher.enqueue(new Uint8Array(10));
    // Exceeded 16; should have flushed immediately.
    expect(writes.length).toBe(1);
    expect(writes[0]!.byteLength).toBe(20);
    expect(ticker.pending).toBe(0);
  });

  it('dispose() cancels the pending frame and drops the queue', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    batcher.enqueue(new Uint8Array([1, 2, 3]));
    expect(ticker.pending).toBe(1);
    batcher.dispose();
    expect(ticker.pending).toBe(0);
    ticker.tick(); // even if a stale frame fires, it must be a no-op
    expect(writes.length).toBe(0);
  });

  it('ignores enqueues after dispose', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    batcher.dispose();
    batcher.enqueue(new Uint8Array([1]));
    expect(batcher.queuedBytes).toBe(0);
    ticker.tick();
    expect(writes.length).toBe(0);
  });

  it('ignores zero-length chunks', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    batcher.enqueue(new Uint8Array(0));
    expect(ticker.pending).toBe(0);
    expect(batcher.queuedBytes).toBe(0);
  });

  it('flush() drains immediately without waiting for the tick', () => {
    const batcher = createWriteBatcher({
      write: (data) => writes.push(data),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    batcher.enqueue(new Uint8Array([7]));
    batcher.flush();
    expect(writes.length).toBe(1);
  });
});
