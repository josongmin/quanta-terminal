/**
 * Perf-test fixture helpers.
 *
 * These helpers build the synthetic byte streams consumed by the four
 * perf-budget tests (`top-60s`, `watch-60s`, `yes-1gb`, `resize-cycle`).
 *
 * Memory-measurement caveat
 * -------------------------
 *  - Node does not expose RSS with high fidelity from within a running
 *    process. We therefore use `process.memoryUsage().heapUsed`, which
 *    captures only V8's heap — external allocations (TypedArray backing
 *    stores, ICU tables) don't count.
 *  - This means the `topMemoryCeilingMb` budget is a *lower bound* on
 *    real-world RSS. An overshoot is always meaningful; staying under
 *    budget is necessary-but-not-sufficient proof of residency health.
 *  - For harder residency proofs, wire a `--expose-gc` run plus an RSS
 *    probe (e.g. `process.memoryUsage().rss`) and compare to a steady
 *    state. Today's budget focuses on heapUsed deltas because that's
 *    what the engine code itself controls.
 *  - Before each measurement window we call `global.gc()` when available
 *    so the "before" heap isn't artificially inflated by prior test
 *    setup. Callers should run node with `--expose-gc` for the
 *    tightest numbers (the CLI runner does this automatically).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a `yes`-style byte stream of exactly `totalBytes` bytes. Each
 * line is `y\n` (2 bytes). Chunks that aren't divisible by 2 drop one
 * trailing byte to avoid a half-line.
 */
export function yesOutput(totalBytes: number): Uint8Array {
  const safeLen = totalBytes - (totalBytes % 2);
  const buf = new Uint8Array(safeLen);
  for (let i = 0; i < safeLen; i += 2) {
    buf[i] = 0x79; // 'y'
    buf[i + 1] = 0x0a; // '\n'
  }
  return buf;
}

/**
 * Loop `input` until the concatenated size ≥ `target` bytes, trimming
 * the tail so the result is exactly `target` bytes. Handy for replaying
 * a short fixture for an extended simulated-time window.
 *
 * Trimming is done on a raw-byte boundary — for fixtures that contain
 * multi-byte UTF-8 or CSI sequences, prefer passing a `target` that's a
 * multiple of the fixture size so we always land on a safe boundary.
 * The VT emulator's FSM tolerates mid-sequence cut-offs at next feed()
 * anyway (it just holds the open state across chunks), so worst-case a
 * trailing CSI gets absorbed on the next loop head.
 */
export function loopFixture(
  input: Uint8Array,
  target: number,
): Uint8Array {
  if (input.byteLength === 0) {
    throw new Error('loopFixture: input must have at least one byte');
  }
  if (target <= 0) return new Uint8Array(0);
  const out = new Uint8Array(target);
  let written = 0;
  while (written < target) {
    const toWrite = Math.min(input.byteLength, target - written);
    out.set(input.subarray(0, toWrite), written);
    written += toWrite;
  }
  return out;
}

/**
 * Load the C-MON-01 (`top` 30 s) fixture from disk and loop it until we
 * have enough bytes to cover roughly `frames` worth of repaint cycles.
 * The fixture contains 3 alt-buffer repaint frames; we amplify by
 * repeating the whole stream `frames / 3` times.
 */
export async function topFrames(frames: number): Promise<Uint8Array> {
  const base = await loadFixtureBytes('C-MON-01');
  const repetitions = Math.max(1, Math.ceil(frames / 3));
  return loopFixture(base, base.byteLength * repetitions);
}

/**
 * Load the C-PG-01 (`less` pager) fixture from disk. Used as a stand-in
 * for a `watch`-like periodic-repaint session — `less` + page-down
 * cycles exhibit the same alt-buffer → full-page CSI repaint pattern
 * that `watch` does, and we already have it in-tree.
 */
export async function watchFrames(frames: number): Promise<Uint8Array> {
  const base = await loadFixtureBytes('C-PG-01');
  const repetitions = Math.max(1, Math.ceil(frames / 3));
  return loopFixture(base, base.byteLength * repetitions);
}

/**
 * Read a compat-fixture `input.bytes` file by id.
 */
async function loadFixtureBytes(id: string): Promise<Uint8Array> {
  const fixtureDir = path.resolve(
    __dirname,
    `../../../fixtures/compat/${id}`,
  );
  const file = path.join(fixtureDir, 'input.bytes');
  const buf = await fs.readFile(file);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Snapshot of memory usage at a moment in time. Fields match
 * `process.memoryUsage()`. We pick off the two numbers that matter:
 * `heapUsed` (V8 heap live set) and `rss` (process-wide resident set,
 * best-effort).
 */
export interface MemorySample {
  readonly heapUsedMb: number;
  readonly rssMb: number;
}

/**
 * Take a memory snapshot after (optionally) forcing GC. Call with
 * `force: true` at both ends of a measurement window to get the tightest
 * delta. Node must be started with `--expose-gc` for the force to work;
 * when it's not available we fall back to a plain reading and the
 * numbers will be somewhat noisier.
 */
export function memorySnapshot(force = false): MemorySample {
  if (force) {
    const g = (globalThis as { gc?: () => void }).gc;
    if (typeof g === 'function') {
      try {
        g();
      } catch {
        // Ignore — heap is still readable.
      }
    }
  }
  const m = process.memoryUsage();
  return {
    heapUsedMb: m.heapUsed / (1024 * 1024),
    rssMb: m.rss / (1024 * 1024),
  };
}

/**
 * Slice a stream into fixed-size chunks. Returns each chunk as a
 * subarray view onto the original buffer — no copying.
 */
export function sliceChunks(
  bytes: Uint8Array,
  chunkBytes: number,
): readonly Uint8Array[] {
  if (chunkBytes <= 0) {
    throw new Error('sliceChunks: chunkBytes must be > 0');
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += chunkBytes) {
    out.push(bytes.subarray(i, Math.min(i + chunkBytes, bytes.byteLength)));
  }
  return out;
}

/**
 * Small synchronous scheduler that fires the callback immediately on the
 * next `runScheduled()` call. Used by perf tests to drive the frame-skip
 * batcher without relying on jsdom's rAF (which is noisy under load).
 */
export interface ManualScheduler {
  schedule: (cb: () => void) => number;
  cancel: (id: number) => void;
  runScheduled: () => void;
  hasPending: () => boolean;
}

export function createManualScheduler(): ManualScheduler {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    schedule(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    runScheduled() {
      // Snapshot so callbacks that re-schedule don't create an infinite
      // loop within a single tick.
      const snapshot = Array.from(pending.values());
      pending.clear();
      for (const cb of snapshot) cb();
    },
    hasPending() {
      return pending.size > 0;
    },
  };
}

/**
 * Drain a frame-skip batcher by repeatedly running its pending
 * frame-scheduler callback until the queue fully flushes or a safety
 * cap is hit. Returns the number of frames run.
 */
export function drainScheduler(
  scheduler: ManualScheduler,
  maxFrames = 100_000,
): number {
  let frames = 0;
  while (scheduler.hasPending() && frames < maxFrames) {
    scheduler.runScheduled();
    frames += 1;
  }
  return frames;
}

/**
 * Shared envelope sink for perf tests — we don't inspect envelopes,
 * but VtEmulator requires the callback. Silent no-op.
 */
export function silentEnvelopeSink(): () => void {
  return () => {
    /* no-op */
  };
}
