/**
 * Session-scoped VT engine — Plan 0005 α1.
 *
 * Every PTY byte for a given session is funnelled through THIS module before
 * any consumer (block router, grid mirror, session recorder, …) is allowed to
 * see the processed stream. The engine is the SSOT for grid state per the
 * SOTA convergence plan; it sits in-line with the `connectSession` pipe.
 *
 * Layering rationale (why each layer exists)
 * ------------------------------------------
 *
 *   PTY bytes (bridge `pty_data` event)
 *        │
 *        ▼
 *   [ createFrameSkipBatcher ]   ← coalesces bursts into one rAF-scoped write,
 *        │                        applies frame-skip back-pressure when a
 *        │                        write overruns the CPU budget, and enforces
 *        │                        soft-cap (SIGSTOP-ready) / hard-cap
 *        │                        (emergency drop, sequence-safe) limits.
 *        ▼
 *   [ VtEmulator.feed(chunk) ]   ← authoritative grid + cursor + scrollback.
 *        │                        Emits GridEventEnvelope<GridPayload> via a
 *        │                        single callback — we multicast that to any
 *        │                        number of subscribers.
 *        ▼
 *   [ engine.subscribe(cb) ]     ← per-consumer fan-out. Used in Epic β by
 *                                  TerminalSurface / GridMirror. In P0 it is
 *                                  optional: no subscriber ⇒ no work.
 *
 * The batcher's `dispose()` intentionally DROPS its internal queue (it is
 * called during teardown paths where flushing is unsafe — e.g. the PTY is
 * already gone). We therefore call `flush()` BEFORE `dispose()` so the
 * emulator still observes the bytes that were in flight; see `dispose()`
 * below for the race discussion.
 *
 * Out of scope for α1:
 *   - Wiring any subscriber (GridMirror / block router) to the engine. That
 *     happens in Epic β / δ. This module only exposes the handle.
 *   - Removing the legacy block-router byte path. In P0 the router still
 *     receives the raw `pty_data` bytes in parallel; Epic δ tears that down.
 */

import {
  createFrameSkipBatcher,
  type BatcherStats,
  type FrameSkipBatcher,
} from '../../shared/lib/write-batcher-frame-skip.js';
import { VtEmulator } from '../../shared/lib/vt-emulator/index.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../shared/lib/grid-mirror/types.js';

/** Envelope subscriber. Must not throw; we guard callers defensively. */
export type EngineEnvelopeListener = (
  envelope: GridEventEnvelope<GridPayload>,
) => void;

export interface VtEngineHandle {
  /**
   * Read-only engine reference for consumers that need cell-level access
   * (e.g. tests, ANSI mirrors). Most consumers should use `subscribe()` to
   * observe grid events rather than poking the emulator directly.
   */
  readonly emulator: VtEmulator;
  /**
   * Subscribe to grid event envelopes. Returns an unsubscribe function.
   * Multiple subscribers are fanned out in registration order; exceptions
   * thrown by one listener do not prevent the rest from seeing the event.
   */
  subscribe(listener: EngineEnvelopeListener): () => void;
  /** Push bytes through the batcher → engine pipeline. */
  feed(chunk: Uint8Array): void;
  /**
   * Resize the engine grid. Routed synchronously (bypasses the batcher) so
   * SIGWINCH-driven redraws don't fight frame-skip timing.
   */
  resize(cols: number, rows: number): void;
  /** Latest batcher counters (bytes in/out, queued, flush counts, …). */
  stats(): BatcherStats;
  /**
   * Dispose: flush any pending batched bytes through the engine, then drop
   * subscribers and halt the batcher. Idempotent.
   *
   * Flushing BEFORE disposing is load-bearing. The underlying
   * `FrameSkipBatcher.dispose()` throws away the queue without writing — that
   * is correct behaviour for the batcher itself (it cannot prove the sink
   * is still safe to call during teardown) but would corrupt our engine's
   * view of the stream. We flush first so the emulator sees every byte that
   * was enqueued; the subsequent dispose() is then a cheap cancel-frame.
   */
  dispose(): void;
}

export interface CreateSessionEngineOptions {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  /**
   * Scrollback ring depth. Defaults to VtEmulator's own default (10 000 rows);
   * surfaced here so tests can pin a smaller value without reaching into
   * emulator internals.
   */
  readonly scrollbackRows?: number;
  /**
   * Test hook: override the batcher's frame scheduler. When omitted the
   * batcher falls back to `requestAnimationFrame` (or a setTimeout(0) shim
   * under Node/jsdom without rAF).
   */
  readonly scheduler?: (cb: () => void) => number;
  readonly cancelScheduler?: (id: number) => void;
}

/**
 * Build a session-scoped VT engine handle.
 *
 * The engine starts IDLE — no bytes are fed until the caller invokes
 * `feed()`. Construction does trigger the initial `grid_snapshot` envelope
 * (VtEmulator emits one from its constructor); subscribers added after
 * construction will only see deltas from subsequent feeds, which is fine —
 * downstream consumers (GridMirror) request an explicit snapshot on attach.
 */
export function createSessionEngine(
  opts: CreateSessionEngineOptions,
): VtEngineHandle {
  const listeners = new Set<EngineEnvelopeListener>();

  const emulator = new VtEmulator({
    sessionId: opts.sessionId,
    rows: opts.rows,
    cols: opts.cols,
    ...(opts.scrollbackRows !== undefined
      ? { scrollbackRows: opts.scrollbackRows }
      : {}),
    // Fan the single VtEmulator callback out to every subscriber. Listeners
    // are invoked in insertion order; one throwing listener MUST NOT starve
    // the rest (a mirror that errors should not take down the recorder).
    onEnvelope: (env) => {
      for (const listener of listeners) {
        try {
          listener(env);
        } catch {
          // Swallow — a buggy subscriber is not allowed to break the bus.
        }
      }
    },
  });

  const batcher: FrameSkipBatcher = createFrameSkipBatcher({
    write: (chunk) => {
      emulator.feed(chunk);
    },
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.cancelScheduler !== undefined
      ? { cancelScheduler: opts.cancelScheduler }
      : {}),
  });

  let disposed = false;

  return {
    emulator,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    feed(chunk) {
      if (disposed) return;
      if (chunk.byteLength === 0) return;
      batcher.enqueue(chunk);
    },
    resize(cols, rows) {
      if (disposed) return;
      // VtEmulator.resize takes (rows, cols). We keep our external signature
      // (cols, rows) aligned with HostBridge.resize for caller ergonomics.
      emulator.resize(rows, cols);
    },
    stats() {
      return batcher.stats();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Drain-before-shutdown: the batcher's own dispose() is destructive;
      // call flush() first so in-flight bytes reach the emulator. After
      // flush, dispose() is a cheap cancel-frame-and-clear.
      try {
        batcher.flush();
      } catch {
        // A sink that throws during the final flush must not prevent us from
        // releasing the frame callback and subscriber refs. The subsequent
        // dispose() is still required.
      }
      batcher.dispose();
      listeners.clear();
    },
  };
}
