/**
 * DECSET 2026 synchronized-update window.
 *
 * While open, `onChange` is suppressed. Instead, dirty-row sets accumulate
 * into an internal union. On `end()` — or after a configurable timeout
 * (RFC 0001 §13.7 cites the reference-impl 150 ms budget) — the accumulated
 * set is flushed via the provided `flush` callback.
 *
 * Timer implementation uses `setTimeout` / `clearTimeout`; callers provide
 * `now()` for deterministic testing (works with `vi.useFakeTimers()`).
 */

import type { MirrorCounterName } from './types.js';

type Flush = (dirty: ReadonlySet<number>) => void;

export interface SyncUpdateWindowOptions {
  readonly timeoutMs: number;
  readonly flush: Flush;
  readonly onTimeout?: () => void;
  readonly now?: () => number;
}

/**
 * Returns a fresh SyncUpdateWindow. `begin()` starts suppression; every
 * `accumulateOrEmit(dirty)` either feeds the accumulator (if in-window) or
 * calls `flush(dirty)` immediately.
 */
export class SyncUpdateWindow {
  private open = false;
  private accumulated = new Set<number>();
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly flush: Flush;
  private readonly onTimeout: (() => void) | undefined;

  constructor(opts: SyncUpdateWindowOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.flush = opts.flush;
    this.onTimeout = opts.onTimeout;
  }

  /** True iff a synchronized window is currently open. */
  isOpen(): boolean {
    return this.open;
  }

  /** Begin a synchronized window. If one is already open, this is a no-op
   *  (extending the window is deferred to the impl-agent's dogfood tuning). */
  begin(): void {
    if (this.open) return;
    this.open = true;
    this.accumulated = new Set<number>();
    this.timerHandle = setTimeout(() => {
      this.onTimeout?.();
      this.forceEnd();
    }, this.timeoutMs);
  }

  /** End a synchronized window cleanly. Fires `flush` with the accumulated
   *  dirty set (which may be empty, in which case `flush` is skipped). */
  end(): void {
    if (!this.open) return;
    this.open = false;
    this.clearTimer();
    const dirty = this.accumulated;
    this.accumulated = new Set<number>();
    if (dirty.size > 0) this.flush(dirty);
  }

  /**
   * Either accumulate into the currently-open window or dispatch immediately
   * when outside a window. The latter path is the common case — most
   * `GridDelta` application happens with no synchronized-update in progress.
   */
  accumulateOrEmit(dirty: ReadonlySet<number>): void {
    if (this.open) {
      for (const r of dirty) this.accumulated.add(r);
      return;
    }
    this.flush(dirty);
  }

  /**
   * Reset the window: called on snapshot reseed. Any accumulated dirty set is
   * discarded (the snapshot is its own `onChange` dispatch source).
   */
  reset(): void {
    this.clearTimer();
    this.open = false;
    this.accumulated = new Set<number>();
  }

  /** Free the timer. Idempotent. */
  dispose(): void {
    this.clearTimer();
    this.open = false;
    this.accumulated = new Set<number>();
  }

  private forceEnd(): void {
    // Timer already fired, so null out the handle before flushing so
    // re-entrant `end()` (late `End` delivery) is a safe no-op.
    this.timerHandle = null;
    if (!this.open) return;
    this.open = false;
    const dirty = this.accumulated;
    this.accumulated = new Set<number>();
    if (dirty.size > 0) this.flush(dirty);
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}

// Unused import guard — `MirrorCounterName` is imported by the main module
// which re-exports for test scaffolding. Kept here as a compile-time reminder
// that `onTimeout` is expected to drive the `synchronized_update_timeouts`
// telemetry counter.
export type { MirrorCounterName };
