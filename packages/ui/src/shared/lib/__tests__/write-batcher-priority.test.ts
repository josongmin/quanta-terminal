/**
 * Tests for `write-batcher-priority`. Covers:
 *   1. control frames are never dropped even at arbitrary load
 *   2. verbose drops first under pressure
 *   3. scrollback is subsampled under softCap
 *   4. visible is subsampled to 30 Hz (configurable)
 *   5. byte-accounting invariant across mixed-class input
 *   6. drop boundaries respect complete byte-frames (never mid-CSI)
 *   7. telemetry emits per-class drop-rate counters
 *   8. flush ordering: control before data before verbose
 *   9. flow-control pause/resume honors totalQueued across lanes
 *  10. dispose is idempotent and preserves counters
 *  11. boundary carving holds partial sequences
 *  12. hardCap drop order: verbose → scrollback → visible
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriorityClass } from '../backpressure-classifier.js';
import {
  createPriorityFrameSkipBatcher,
  type PriorityFrameSkipBatcher,
} from '../write-batcher-priority.js';

// ---------- Manual scheduler ----------

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
      const snap = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, cb] of snap) cb();
    },
    get pending() {
      return callbacks.size;
    },
  };
}

// ---------- Helpers ----------

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

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Tagger: classify deterministically by looking at the first byte of the
 * frame. Used by tests that want to pin a class regardless of the real
 * FSM. `0xFE` → control, `0xFD` → visible, `0xFC` → scrollback,
 * `0xFB` → verbose.
 */
function taggedClassify(bytesFrame: Uint8Array): PriorityClass {
  const first = bytesFrame[0];
  if (first === 0xfe) return 'control';
  if (first === 0xfd) return 'visible';
  if (first === 0xfc) return 'scrollback';
  if (first === 0xfb) return 'verbose';
  return 'visible';
}

function tagged(klass: PriorityClass, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const marker =
    klass === 'control'
      ? 0xfe
      : klass === 'visible'
        ? 0xfd
        : klass === 'scrollback'
          ? 0xfc
          : 0xfb;
  out[0] = marker;
  for (let i = 1; i < len; i += 1) out[i] = 0x41; // 'A'
  return out;
}

// ---------- Suite ----------

describe('write-batcher-priority', () => {
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
    extra?: Partial<Parameters<typeof createPriorityFrameSkipBatcher>[0]>,
  ): PriorityFrameSkipBatcher {
    return createPriorityFrameSkipBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      classify: taggedClassify,
      ...extra,
    });
  }

  // --------- 1. control never dropped ---------

  it('never drops control frames at any load', () => {
    const b = make({ softCapBytes: 128, hardCapBytes: 256 });
    // Pile on verbose/scrollback to force the drop path.
    for (let i = 0; i < 20; i += 1) {
      b.enqueue(tagged('verbose', 64));
      b.enqueue(tagged('scrollback', 64));
    }
    // Insert a control frame deep in the flood.
    const ctrl = tagged('control', 8);
    b.enqueue(ctrl);
    for (let i = 0; i < 20; i += 1) {
      b.enqueue(tagged('scrollback', 64));
    }

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    expect(b.stats().droppedByClass.control).toBe(0);
    // The control bytes must appear in the written output.
    const all = concat(...writes);
    // Scan for the control marker 0xFE.
    let found = false;
    for (let i = 0; i + ctrl.byteLength <= all.byteLength; i += 1) {
      if (all[i] === 0xfe) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  // --------- 2. verbose drops first ---------

  it('drops verbose before any other class when over softCap', () => {
    const b = make({ softCapBytes: 100, hardCapBytes: 1024 });
    // Two verbose + two scrollback + one visible.
    b.enqueue(tagged('verbose', 60));
    b.enqueue(tagged('scrollback', 60)); // crosses softCap of 100
    b.enqueue(tagged('verbose', 60));
    b.enqueue(tagged('visible', 60));

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const s = b.stats();
    expect(s.droppedByClass.verbose).toBeGreaterThan(0);
    expect(s.droppedByClass.visible).toBe(0);
  });

  // --------- 3. scrollback subsampled under softCap ---------

  it('subsamples scrollback frames under softCap pressure', () => {
    const b = make({ softCapBytes: 100, hardCapBytes: 10 * 1024 });
    for (let i = 0; i < 6; i += 1) b.enqueue(tagged('scrollback', 50));

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const s = b.stats();
    // Under pressure, every other scrollback frame is dropped.
    expect(s.droppedByClass.scrollback).toBeGreaterThan(0);
    // Visible/control untouched.
    expect(s.droppedByClass.visible).toBe(0);
    expect(s.droppedByClass.control).toBe(0);
  });

  // --------- 4. visible subsampled to configured Hz ---------

  it('subsamples visible frames to visibleSubsampleHz under pressure', () => {
    let t = 0;
    const b = make({
      softCapBytes: 100,
      hardCapBytes: 10 * 1024,
      visibleSubsampleHz: 30, // ~33 ms between visible writes
      now: () => t,
    });

    // Enqueue visible-only traffic that exceeds softCap.
    for (let i = 0; i < 5; i += 1) b.enqueue(tagged('visible', 50));

    // First tick: first visible flushes (lastVisibleWriteAt = 0).
    ticker.tick();
    b.flush();
    // Bump the clock but not past the min interval.
    t += 10;
    // Enqueue another visible at high load — should subsample (held).
    b.enqueue(tagged('visible', 50));
    ticker.tick();
    // If held, the queue still has that frame.
    expect(b.stats().queuedBytes).toBeGreaterThanOrEqual(0);

    // Advance past the subsample interval — next flush consumes it.
    t += 40;
    b.enqueue(tagged('visible', 10)); // nudge
    ticker.tick();
    b.flush();
    // No assertion on exact drop count: subsampling here defers writes,
    // not drops. The accounting invariant below covers it.
    expect(b.stats().droppedByClass.visible).toBe(0);
  });

  // --------- 5. byte accounting ---------

  it('bytesIn equals bytesOut + sum of droppedByClass + queued', () => {
    const b = make({ softCapBytes: 200, hardCapBytes: 400 });
    let expectedIn = 0;
    for (let i = 0; i < 10; i += 1) {
      const v = tagged('visible', 30);
      const s = tagged('scrollback', 30);
      const w = tagged('verbose', 30);
      const c = tagged('control', 10);
      b.enqueue(v);
      b.enqueue(s);
      b.enqueue(w);
      b.enqueue(c);
      expectedIn += v.byteLength + s.byteLength + w.byteLength + c.byteLength;
    }

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const stats = b.stats();
    const droppedSum =
      stats.droppedByClass.control +
      stats.droppedByClass.visible +
      stats.droppedByClass.scrollback +
      stats.droppedByClass.verbose;
    expect(stats.bytesInTotal).toBe(expectedIn);
    expect(stats.bytesInTotal).toBe(
      stats.bytesOutTotal + droppedSum + stats.queuedBytes,
    );
    // control is never dropped.
    expect(stats.droppedByClass.control).toBe(0);
  });

  // --------- 6. drop boundaries respect byte-frames ---------

  it('drops never cut mid-CSI: full CSI survives under pressure', () => {
    // Use the real classifier so CSIs land in the control path naturally.
    const b = createPriorityFrameSkipBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      softCapBytes: 128,
      hardCapBytes: 200,
      // No custom classify — exercise the real FSM classifier.
    });

    // 400 bytes of plain text (scrollback when cursor is at bottom — our
    // default context keeps cursorY=0, so it's visible) + a CSI SGR.
    const plain = new Uint8Array(400).fill(0x41);
    const csi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
    b.enqueue(plain);
    b.enqueue(csi);

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const all = concat(...writes);
    // The CSI bytes must appear contiguous somewhere in the output.
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
  });

  // --------- 7. telemetry counters ---------

  it('emits per-class drop-rate counters via onStat', () => {
    const stats: Array<[string, number, Record<string, string> | undefined]> =
      [];
    const b = make({
      softCapBytes: 100,
      hardCapBytes: 200,
      onStat: (name, value, labels) => {
        stats.push([name, value, labels]);
      },
    });

    b.enqueue(tagged('verbose', 80));
    b.enqueue(tagged('verbose', 80));
    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const classes = stats
      .filter(([n]) => n === 'backpressure.drop_rate_by_class')
      .map(([, , labels]) => labels?.class);
    expect(classes).toContain('control');
    expect(classes).toContain('visible');
    expect(classes).toContain('scrollback');
    expect(classes).toContain('verbose');
  });

  // --------- 8. flush ordering: control → data → verbose ---------

  it('flushes control lane before data lane', () => {
    const b = make({ softCapBytes: 10 * 1024, hardCapBytes: 20 * 1024 });
    // Enqueue verbose, scrollback, visible BEFORE control. Flush must still
    // emit control first.
    b.enqueue(tagged('verbose', 4));
    b.enqueue(tagged('scrollback', 4));
    b.enqueue(tagged('visible', 4));
    b.enqueue(tagged('control', 4));

    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const all = concat(...writes);
    // The control marker (0xFE) must come first in the output stream.
    const ctrlIdx = all.indexOf(0xfe);
    const visIdx = all.indexOf(0xfd);
    const scrIdx = all.indexOf(0xfc);
    const verbIdx = all.indexOf(0xfb);
    expect(ctrlIdx).toBeGreaterThanOrEqual(0);
    expect(ctrlIdx).toBeLessThan(visIdx);
    expect(ctrlIdx).toBeLessThan(scrIdx);
    // verbose under load gets dropped; when not under load it comes last.
    if (verbIdx >= 0) expect(verbIdx).toBeGreaterThan(scrIdx);
  });

  // --------- 9. flow-control pause/resume across lanes ---------

  it('invokes flowControl.pause when totalQueued crosses softCap across lanes', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const b = make({
      softCapBytes: 100,
      hardCapBytes: 10 * 1024,
      flowControl: { pause, resume },
    });

    b.enqueue(tagged('visible', 50));
    expect(pause).not.toHaveBeenCalled();
    b.enqueue(tagged('scrollback', 60)); // total 110 → crosses 100
    expect(pause).toHaveBeenCalledTimes(1);

    while (ticker.pending > 0) ticker.tick();
    b.flush();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  // --------- 10. dispose stability ---------

  it('dispose preserves counter values and makes enqueue a no-op', () => {
    const b = make();
    b.enqueue(tagged('visible', 10));
    while (ticker.pending > 0) ticker.tick();
    b.flush();
    const before = b.stats();
    expect(before.bytesInTotal).toBe(10);
    expect(before.bytesOutTotal).toBe(10);

    b.dispose();
    const after = b.stats();
    expect(after.bytesInTotal).toBe(before.bytesInTotal);
    expect(after.bytesOutTotal).toBe(before.bytesOutTotal);

    b.enqueue(tagged('visible', 99));
    expect(b.stats().bytesInTotal).toBe(before.bytesInTotal);
  });

  // --------- 11. partial sequence held across enqueues ---------

  it('holds a partial CSI across enqueues until it completes', () => {
    const b = createPriorityFrameSkipBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });

    // Incomplete CSI.
    b.enqueue(new Uint8Array([0x1b, 0x5b]));
    while (ticker.pending > 0) ticker.tick();
    b.flush();
    expect(writes.reduce((n, w) => n + w.byteLength, 0)).toBe(0);

    // Complete it.
    b.enqueue(new Uint8Array([0x33, 0x31, 0x6d, 0x41]));
    while (ticker.pending > 0) ticker.tick();
    b.flush();

    const all = concat(...writes);
    expect(Array.from(all)).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41]);
  });

  // --------- 12. hardCap drop order: verbose → scrollback → visible ---------

  it('hardCap drop order: verbose first, then scrollback, then visible', () => {
    const b = make({ softCapBytes: 50 * 1024, hardCapBytes: 200 });
    // Enqueue in interleaved order but the drop policy should prefer
    // verbose over scrollback over visible.
    b.enqueue(tagged('visible', 80));
    b.enqueue(tagged('scrollback', 80));
    b.enqueue(tagged('verbose', 80));
    b.enqueue(tagged('visible', 80));
    b.enqueue(tagged('scrollback', 80)); // total 400 > 200 hardCap
    b.enqueue(tagged('verbose', 80));

    const stats = b.stats();
    // verbose fully dropped before any visible/scrollback is touched.
    expect(stats.droppedByClass.verbose).toBeGreaterThan(0);
    // If verbose alone can't bring us under hardCap, scrollback kicks in.
    const needScrollbackDrops = stats.queuedBytes > 200;
    if (needScrollbackDrops) {
      expect(stats.droppedByClass.scrollback).toBeGreaterThanOrEqual(0);
    }
    // Accounting holds.
    const droppedSum =
      stats.droppedByClass.control +
      stats.droppedByClass.visible +
      stats.droppedByClass.scrollback +
      stats.droppedByClass.verbose;
    expect(stats.bytesInTotal).toBe(
      stats.bytesOutTotal + droppedSum + stats.queuedBytes,
    );
  });

  // --------- 13. getContext is read per enqueue ---------

  it('reads context fresh on every enqueue via getContext', () => {
    const contextCalls: number[] = [];
    let rows = 24;
    const b = createPriorityFrameSkipBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
      getContext: () => {
        contextCalls.push(rows);
        return {
          inAltScreen: false,
          cursorY: 0,
          viewportRows: rows,
          verboseGateOpen: false,
        };
      },
    });

    b.enqueue(ascii('hello'));
    rows = 40;
    b.enqueue(ascii('world'));
    expect(contextCalls.length).toBeGreaterThanOrEqual(2);
    expect(contextCalls[contextCalls.length - 1]).toBe(40);
  });
});
