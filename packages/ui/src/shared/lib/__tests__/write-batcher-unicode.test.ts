/**
 * write-batcher Unicode / CJK / chunk-split tests.
 *
 * The core invariant: every byte that enters the batcher via `enqueue` must
 * reach `term.write` byte-identical. The batcher MUST NOT ever decode bytes
 * to a `string` on the path from `base64 → Uint8Array → term.write` — doing
 * so would substitute U+FFFD into any multi-byte codepoint split across
 * chunks, which is the "한글깨짐 (Korean corruption)" bug class.
 *
 * These tests use fixed byte arrays — never `new TextEncoder().encode("한")`
 * inside the body — so the bytes being asserted are the exact bytes a real
 * PTY emits. Determinism is load-bearing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64ToBytes } from '../base64.js';
import { createWriteBatcher } from '../write-batcher.js';

// ---------- Manual scheduler from the sibling test file ----------

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

// ---------- Known byte sequences ----------

// "안" = EC 95 88, "녕" = EB 85 95, "하" = ED 95 98, "세" = EC 84 B8, "요" = EC 9A 94.
const ANNYEONG_BYTES = new Uint8Array([
  0xec, 0x95, 0x88, 0xeb, 0x85, 0x95, 0xed, 0x95, 0x98, 0xec, 0x84, 0xb8, 0xec, 0x9a, 0x94,
]);

// "👋🏽" = waving-hand + medium skin-tone (ZWJ sequence).
// F0 9F 91 8B  F0 9F 8F BD
const WAVING_MED_BYTES = new Uint8Array([0xf0, 0x9f, 0x91, 0x8b, 0xf0, 0x9f, 0x8f, 0xbd]);

// ANSI CSI SGR: ESC [ 3 1 m → bytes 0x1B 0x5B 0x33 0x31 0x6D (red foreground).
const SGR_RED = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
const SGR_RESET = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]);

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

describe('write-batcher / CJK / chunk-split', () => {
  let ticker: ManualScheduler;
  let writes: Uint8Array[];

  beforeEach(() => {
    ticker = makeManualScheduler();
    writes = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Korean "안녕하세요" split across 3 chunks at arbitrary byte boundaries emits the full sequence', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // Split at byte 4 (mid-"녕") and byte 10 (mid-"세").
    const part1 = ANNYEONG_BYTES.slice(0, 4);
    const part2 = ANNYEONG_BYTES.slice(4, 10);
    const part3 = ANNYEONG_BYTES.slice(10);
    b.enqueue(part1);
    b.enqueue(part2);
    b.enqueue(part3);
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0]!)).toEqual(Array.from(ANNYEONG_BYTES));
  });

  it('Emoji "👋🏽" (ZWJ + modifier) split mid-sequence preserves bytes', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // Split inside the first emoji (byte 2) and between the two emojis (byte 4).
    b.enqueue(WAVING_MED_BYTES.slice(0, 2));
    b.enqueue(WAVING_MED_BYTES.slice(2, 4));
    b.enqueue(WAVING_MED_BYTES.slice(4, 6));
    b.enqueue(WAVING_MED_BYTES.slice(6));
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0]!)).toEqual(Array.from(WAVING_MED_BYTES));
  });

  it('Mixed ASCII + CJK + ANSI SGR interleaved preserves every byte in order', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    const ascii = new Uint8Array([0x68, 0x69, 0x20]); // "hi "
    const newline = new Uint8Array([0x0a]);

    // Put ANSI escapes split across chunks that ALSO split the next CJK.
    b.enqueue(SGR_RED.slice(0, 2));
    b.enqueue(concat(SGR_RED.slice(2), ascii));
    // Split "안" between chunks 3/4.
    b.enqueue(ANNYEONG_BYTES.slice(0, 2));
    b.enqueue(ANNYEONG_BYTES.slice(2));
    b.enqueue(SGR_RESET);
    b.enqueue(newline);
    ticker.tick();

    const expected = concat(SGR_RED, ascii, ANNYEONG_BYTES, SGR_RESET, newline);
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0]!)).toEqual(Array.from(expected));
  });

  it('a single-byte chunk followed by the remaining bytes of a codepoint flushes as one merged write', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // "한" = ED 95 9C, split at every possible position.
    const han = new Uint8Array([0xed, 0x95, 0x9c]);
    b.enqueue(han.slice(0, 1));
    b.enqueue(han.slice(1, 2));
    b.enqueue(han.slice(2, 3));
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0]!)).toEqual(Array.from(han));
  });

  it('term.write is called with Uint8Array (not string) — no TextDecoder on the path', () => {
    // This test pins the byte-transparency contract. If someone accidentally
    // inserts a TextDecoder() between base64 and term.write, the argument
    // becomes a string and this test fires.
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // Simulate the base64 → bytes → batcher path the widget uses.
    b.enqueue(ANNYEONG_BYTES);
    ticker.tick();
    expect(writes.length).toBe(1);
    const out = writes[0]!;
    // Strict type assertion: the write target must be a Uint8Array, not a
    // string. jsdom's global `Uint8Array` is the same identity as the one
    // the batcher exposes, so `instanceof` is safe here.
    expect(out).toBeInstanceOf(Uint8Array);
    expect(typeof out).not.toBe('string');
  });

  it('base64ToBytes + enqueue preserves raw bytes for CJK payloads', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // Base64 encoding of ANNYEONG_BYTES.
    // Using btoa on latin-1 chars is safe because atob/btoa work over
    // arbitrary byte sequences when treated as latin-1.
    let binary = '';
    for (const byte of ANNYEONG_BYTES) binary += String.fromCharCode(byte);
    const b64 = btoa(binary);
    // Simulate the widget's call: base64 → Uint8Array → enqueue.
    b.enqueue(base64ToBytes(b64));
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0]!)).toEqual(Array.from(ANNYEONG_BYTES));
  });

  it('flushing a burst of 100 small CJK chunks produces ONE concatenated write', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    // 100 copies of a 3-byte "한".
    const han = new Uint8Array([0xed, 0x95, 0x9c]);
    for (let i = 0; i < 100; i += 1) b.enqueue(han.slice(0));
    ticker.tick();
    expect(writes.length).toBe(1);
    expect(writes[0]!.byteLength).toBe(300);
    // Every 3-byte window should be exactly HAN.
    for (let off = 0; off < 300; off += 3) {
      expect(Array.from(writes[0]!.slice(off, off + 3))).toEqual([0xed, 0x95, 0x9c]);
    }
  });

  it('dispose before tick with CJK queued drops the bytes and does not call write', () => {
    const b = createWriteBatcher({
      write: (d) => writes.push(d),
      scheduler: ticker.schedule,
      cancelScheduler: ticker.cancel,
    });
    b.enqueue(ANNYEONG_BYTES);
    expect(b.queuedBytes).toBe(ANNYEONG_BYTES.byteLength);
    b.dispose();
    ticker.tick();
    expect(writes.length).toBe(0);
  });
});
