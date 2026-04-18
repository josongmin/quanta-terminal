/**
 * write-batcher — coalesces PTY byte frames so a burst of many small chunks
 * collapses into at most one `term.write` per animation frame.
 *
 * Problem it solves
 * -----------------
 * A busy shell (e.g. `find /`, `yarn install`) emits hundreds of `pty_data`
 * events per second — each with a few bytes. Forwarding every event directly
 * into `term.write` forces xterm to do per-chunk layout work and starves the
 * main thread, because each write triggers renderer work on the next tick.
 *
 * Design
 * ------
 * - Accept `Uint8Array` chunks; xterm accepts them natively (no re-encode).
 * - Queue chunks in a ring and schedule one flush per animation frame.
 * - Concatenate into a single `Uint8Array` at flush time and issue ONE write.
 * - On the final flush (dispose), pass a completion callback to
 *   `term.write(data, cb)` so callers can await drain if needed.
 *
 * The batcher is framework-agnostic: the xterm dependency is injected as a
 * `write(data)` function so this module stays trivially testable.
 */

import { mark, measure } from './perf.js';

export type WriteFn = (data: Uint8Array, done?: () => void) => void;

export interface WriteBatcherOptions {
  /** The underlying write implementation (e.g. `term.write.bind(term)`). */
  readonly write: WriteFn;
  /**
   * Frame scheduler. Defaults to `requestAnimationFrame`, falls back to a
   * `setTimeout(0)` shim when rAF is unavailable (Node/jsdom without it).
   * Tests may inject a manual ticker.
   */
  readonly scheduler?: (cb: () => void) => number;
  readonly cancelScheduler?: (id: number) => void;
  /**
   * Soft cap on queued bytes. When exceeded, flush eagerly without waiting for
   * the next frame. Prevents one frame's worth of output from ballooning to
   * hundreds of megabytes if rAF is starved (e.g. tab in background).
   * Default: 1 MiB.
   */
  readonly flushBytesThreshold?: number;
}

export interface WriteBatcher {
  /** Enqueue a chunk. Schedules a flush on the next frame if none is pending. */
  enqueue(chunk: Uint8Array): void;
  /** Force-flush right now. Safe to call at any time. */
  flush(): void;
  /**
   * Dispose: cancels any pending frame and synchronously drops the queue.
   * After dispose, further `enqueue` calls are no-ops. Idempotent.
   */
  dispose(): void;
  /** Number of bytes currently queued. Test hook. */
  readonly queuedBytes: number;
  /** Number of flushes performed so far. Test hook. */
  readonly flushCount: number;
}

const DEFAULT_FLUSH_BYTES = 1024 * 1024;

function defaultScheduler(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(cb, 0) as unknown as number;
}

function defaultCancel(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

export function createWriteBatcher(options: WriteBatcherOptions): WriteBatcher {
  const schedule = options.scheduler ?? defaultScheduler;
  const cancel = options.cancelScheduler ?? defaultCancel;
  const flushThreshold = options.flushBytesThreshold ?? DEFAULT_FLUSH_BYTES;

  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let scheduled: number | undefined;
  let disposed = false;
  let flushCount = 0;

  function flush(): void {
    scheduled = undefined;
    if (queue.length === 0) return;

    mark('term.write-start');

    let merged: Uint8Array;
    if (queue.length === 1) {
      merged = queue[0]!;
    } else {
      merged = new Uint8Array(queuedBytes);
      let offset = 0;
      for (const chunk of queue) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    queue.length = 0;
    queuedBytes = 0;
    flushCount += 1;

    try {
      options.write(merged);
    } finally {
      mark('term.write-end');
      measure('term.write', 'term.write-start', 'term.write-end');
    }
  }

  return {
    enqueue(chunk) {
      if (disposed) return;
      if (chunk.byteLength === 0) return;
      queue.push(chunk);
      queuedBytes += chunk.byteLength;

      // Eager flush when the queue grows beyond the soft cap — e.g. if rAF is
      // throttled because the window is backgrounded, we still want bounded
      // memory use.
      if (queuedBytes >= flushThreshold) {
        if (scheduled !== undefined) {
          cancel(scheduled);
          scheduled = undefined;
        }
        flush();
        return;
      }

      if (scheduled === undefined) {
        scheduled = schedule(() => {
          // If disposed between scheduling and firing, drop.
          if (disposed) {
            scheduled = undefined;
            return;
          }
          flush();
        });
      }
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scheduled !== undefined) {
        cancel(scheduled);
        scheduled = undefined;
      }
      queue.length = 0;
      queuedBytes = 0;
    },
    get queuedBytes() {
      return queuedBytes;
    },
    get flushCount() {
      return flushCount;
    },
  };
}
