/**
 * Tests for `write-batcher-frame-skip`. Covers:
 *   1. byte-frame boundary preservation (CSI split, OSC split at ST)
 *   2. byte-accounting invariant across random small enqueues
 *   3. flow-control pause/resume at soft cap
 *   4. emergency drop at hard cap when no flow-control wired
 *   5. frame-skip when a write exceeds the CPU budget
 *   6. counter stability across dispose
 *
 * The manual scheduler mirrors the sibling `write-batcher.test.ts` style so
 * the two suites stay readable side-by-side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  createFrameSkipBatcher,
  type FrameSkipBatcher,
} from '../write-batcher-frame-skip.js';

// ---------- Manual scheduler ----------

interface ManualScheduler {
  schedule: (cb: () => void) => number;
  cancel: (id: number) => void;
  tick: () => void;
  pending: number;
  scheduleCount: number;
}

function makeManualScheduler(): ManualScheduler {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  let scheduleCount = 0;
  return {
    schedule: (cb) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, cb);
      scheduleCount += 1;
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
    tick: () => {
      const snap = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, cb] of snap) cb();
    },
    get pending() {
      return callbacks.size;
    },
    get scheduleCount() {
      return scheduleCount;
    },
  };
}

// ---------- Byte helpers ----------

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}

// ---------- Suite ----------

describe('write-batcher-frame-skip', () => {
  let ticker: ManualScheduler;
  let writes: Uint8Array[];

  beforeEach(() => {
    ticker = makeManualScheduler();
    writes = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function make(
    extra?: Partial<Parameters<typeof createFrameSkipBatcher>[0]>,
  ): FrameSkipBatcher {
    return createFrameSkipBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      ...extra,
    });
  }

  // --------- 1. Frame boundary preservation: CSI split ---------

  it('holds an incomplete CSI across flushes and emits the full 7 bytes once finalised', () => {
    const b = make();
    // ESC [ — incomplete.
    b.enqueue(new Uint8Array([0x1b, 0x5b]));
    b.flush();
    const totalAfterFirst = writes.reduce((n, w) => n + w.byteLength, 0);
    expect(totalAfterFirst).toBe(0);

    // 3 1 m A — '3','1' are params, 'm' is the CSI final, 'A' is plain text.
    b.enqueue(new Uint8Array([0x33, 0x31, 0x6d, 0x41]));
    b.flush();
    const all = concat(...writes);
    expect(Array.from(all)).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41]);
    // And total bytes written equals total bytes in.
    expect(all.byteLength).toBe(6);
    expect(b.stats().bytesInTotal).toBe(6);
    expect(b.stats().bytesOutTotal).toBe(6);
  });

  // --------- 2. Frame boundary preservation: OSC split at ST ---------

  it('holds OSC bytes split across 3 enqueues until ST (ESC \\) arrives', () => {
    const b = make();
    // Payload: ESC ] 0 ; t i t l e ESC \
    const p1 = new Uint8Array([0x1b, 0x5d, 0x30, 0x3b]); // ESC ] 0 ;
    const p2 = new Uint8Array([0x74, 0x69, 0x74, 0x6c, 0x65]); // t i t l e
    const p3 = new Uint8Array([0x1b, 0x5c]); // ESC \

    b.enqueue(p1);
    b.flush();
    expect(writes.reduce((n, w) => n + w.byteLength, 0)).toBe(0);

    b.enqueue(p2);
    b.flush();
    expect(writes.reduce((n, w) => n + w.byteLength, 0)).toBe(0);

    b.enqueue(p3);
    b.flush();
    const all = concat(...writes);
    expect(Array.from(all)).toEqual([
      0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x1b, 0x5c,
    ]);
  });

  // --------- 3. Byte-accounting invariant ---------

  it('bytesIn equals bytesOut after draining 1000 random small chunks', () => {
    const b = make();
    // Deterministic pseudo-random sequence so failures reproduce.
    let rng = 0x12345678;
    function next(): number {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng;
    }
    let expectedTotal = 0;
    for (let i = 0; i < 1000; i += 1) {
      const size = 1 + (next() % 16);
      const arr = new Uint8Array(size);
      for (let j = 0; j < size; j += 1) {
        // Keep bytes in 0x20..0x7E range so we never spawn a real escape
        // sequence. We test escape behaviour in the dedicated CSI/OSC tests.
        arr[j] = 0x20 + (next() % 0x5e);
      }
      b.enqueue(arr);
      expectedTotal += size;
    }

    // Drain: repeatedly tick and flush; since there are no open sequences,
    // everything flushes.
    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const stats = b.stats();
    expect(stats.bytesInTotal).toBe(expectedTotal);
    expect(stats.bytesOutTotal).toBe(expectedTotal);
    expect(stats.emergencyDroppedBytesTotal).toBe(0);
    expect(stats.bytesInTotal).toBe(stats.bytesOutTotal + stats.emergencyDroppedBytesTotal);
  });

  // --------- 4. Flow control engages at soft cap ---------

  it('calls flowControl.pause at soft cap and resume after drain below 75 %', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    // softCapBytes=1024, so crossing 1024 triggers pause; crossing below 768
    // triggers resume.
    const b = make({
      softCapBytes: 1024,
      hardCapBytes: 4 * 1024 * 1024,
      flowControl: { pause, resume },
    });

    // Send 2 KiB of plain text (no escapes). The data path takes `pause`
    // immediately on the enqueue that crosses the threshold.
    const half = new Uint8Array(600).fill(0x41); // 'A'
    b.enqueue(half); // 600 queued
    expect(pause).not.toHaveBeenCalled();
    b.enqueue(half); // 1200 queued, crosses 1024
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    // Another enqueue must not re-invoke pause (idempotence).
    b.enqueue(new Uint8Array(100).fill(0x42));
    expect(pause).toHaveBeenCalledTimes(1);

    // Drain.
    while (ticker.pending > 0) ticker.tick();
    b.flush();

    expect(resume).toHaveBeenCalledTimes(1);
    // Further flushes must not re-invoke resume.
    b.flush();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  // --------- 5. Emergency drop at hard cap (no flow-control) ---------

  it('drops oldest complete byte-frames when hard cap exceeded without flow-control', () => {
    // No `flowControl` option — drop path must engage.
    const b = make({
      softCapBytes: 4 * 1024 * 1024,
      hardCapBytes: 1024,
    });

    // Fill with plain bytes — every byte is a complete "frame" from the FSM's
    // POV (Ground -> Ground), so drop alignment is trivial.
    const chunk = new Uint8Array(512).fill(0x58); // 'X'
    b.enqueue(chunk);
    b.enqueue(chunk);
    b.enqueue(chunk); // 1536 queued, above 1024 cap

    const stats = b.stats();
    expect(stats.emergencyDroppedBytesTotal).toBeGreaterThan(0);
    expect(stats.bytesInTotal).toBe(
      stats.bytesOutTotal + stats.emergencyDroppedBytesTotal + stats.queuedBytes,
    );

    // Flush the rest and re-check invariant.
    while (ticker.pending > 0) ticker.tick();
    b.flush();
    const final = b.stats();
    expect(final.bytesInTotal).toBe(final.bytesOutTotal + final.emergencyDroppedBytesTotal);
  });

  it('drop path never cuts mid-escape: leaves a CSI intact at the tail', () => {
    const b = make({
      softCapBytes: 4 * 1024 * 1024,
      hardCapBytes: 32,
    });

    // 40 bytes of plain 'A' + a CSI SGR. Total 45 bytes. Hard cap = 32.
    // Drop must choose a boundary that is not mid-CSI.
    const plain = new Uint8Array(40).fill(0x41);
    const csi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]); // ESC [ 3 1 m
    b.enqueue(plain);
    b.enqueue(csi);

    // Flush whatever is left; the CSI must be delivered intact.
    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const all = concat(...writes);
    // The CSI is 5 bytes. It must appear contiguous in the written output.
    let found = -1;
    for (let i = 0; i + csi.byteLength <= all.byteLength; i += 1) {
      let match = true;
      for (let j = 0; j < csi.byteLength; j += 1) {
        if (all[i + j] !== csi[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        found = i;
        break;
      }
    }
    expect(found).toBeGreaterThanOrEqual(0);

    const stats = b.stats();
    expect(stats.bytesInTotal).toBe(stats.bytesOutTotal + stats.emergencyDroppedBytesTotal);
  });

  // --------- 6. Frame-skip on long write ---------

  it('defers the next flush by one frame when write() exceeds maxFeedCpuMs', () => {
    // Inject a monotonic clock that advances by 20 ms inside `write`.
    let t = 0;
    const b = createFrameSkipBatcher({
      write: (d) => {
        writes.push(d);
        t += 20; // synthetic cost
      },
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      maxFeedCpuMs: 8,
      now: () => t,
    });

    b.enqueue(new Uint8Array([0x41, 0x42, 0x43])); // plain 'ABC'
    // First scheduled callback fires (normal flush).
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(b.stats().frameSkipCount).toBe(0);

    // Queue more — the NEXT flush should consume a frame as a skip before
    // actually writing. We assert by enqueueing after the slow write and
    // watching frameSkipCount tick up.
    b.enqueue(new Uint8Array([0x44, 0x45]));
    // Tick once: scheduler callback fires, sees deferNextFlush=true, eats
    // a frame (increments frameSkipCount), re-schedules for the next frame.
    ticker.tick();
    expect(b.stats().frameSkipCount).toBe(1);
    // The bytes have NOT been written yet — we skipped.
    const beforeSkipWrites = writes.length;
    // Tick again: the deferred flush fires, writes go out.
    ticker.tick();
    expect(writes.length).toBeGreaterThan(beforeSkipWrites);
  });

  // --------- 7. Counter stability across dispose ---------

  it('dispose does not corrupt counters returned by stats()', () => {
    const b = make();
    b.enqueue(new Uint8Array([0x41, 0x42, 0x43]));
    b.flush();
    const before = b.stats();
    expect(before.bytesInTotal).toBe(3);
    expect(before.bytesOutTotal).toBe(3);

    b.dispose();
    const after = b.stats();
    expect(after.bytesInTotal).toBe(3);
    expect(after.bytesOutTotal).toBe(3);
    expect(after.emergencyDroppedBytesTotal).toBe(0);
    // Post-dispose enqueue is a no-op.
    b.enqueue(new Uint8Array([0x44]));
    expect(b.stats().bytesInTotal).toBe(3);
  });

  // --------- 8. Boundary detector unit checks ---------

  describe('byte-frame FSM', () => {
    it('classifies CSI final correctly', () => {
      let s: ReturnType<typeof __testing.step> = 'Ground';
      s = __testing.step(s, 0x1b); // ESC
      expect(s).toBe('Esc');
      s = __testing.step(s, 0x5b); // [
      expect(s).toBe('Csi');
      s = __testing.step(s, 0x33); // '3'
      s = __testing.step(s, 0x31); // '1'
      expect(s).toBe('Csi');
      s = __testing.step(s, 0x6d); // 'm' — final
      expect(s).toBe('Ground');
    });

    it('classifies OSC with ST terminator', () => {
      const bytes = [0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x69, 0x1b, 0x5c];
      let s: ReturnType<typeof __testing.step> = 'Ground';
      for (const b of bytes) s = __testing.step(s, b);
      expect(s).toBe('Ground');
    });

    it('classifies DCS with BEL terminator (tolerant)', () => {
      // ESC P ...  (no ST) — should STAY in Dcs, i.e. not Ground.
      const bytes = [0x1b, 0x50, 0x31, 0x32];
      let s: ReturnType<typeof __testing.step> = 'Ground';
      for (const b of bytes) s = __testing.step(s, b);
      expect(s).toBe('Dcs');
      // Now feed BEL — returns to Ground (xterm accepts BEL as string term).
      s = __testing.step(s, 0x07);
      expect(s).toBe('Ground');
    });

    it('findLastSafeBoundary returns 0 when the entire stream is in a sequence', () => {
      const chunks = [new Uint8Array([0x1b, 0x5b, 0x33, 0x31])]; // incomplete CSI
      const { cut, endState } = __testing.findLastSafeBoundary(chunks, 'Ground', 4);
      expect(cut).toBe(0);
      expect(endState).toBe('Csi');
    });

    it('findLastSafeBoundary returns total when everything is complete', () => {
      const chunks = [new Uint8Array([0x41, 0x42, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x43])];
      const { cut, endState } = __testing.findLastSafeBoundary(chunks, 'Ground', 8);
      expect(cut).toBe(8);
      expect(endState).toBe('Ground');
    });
  });
});
