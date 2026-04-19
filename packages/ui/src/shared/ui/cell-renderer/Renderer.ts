/**
 * Renderer — rAF-driven paint loop composing three layers (grid cells,
 * cursor, overlay).
 *
 * Damage coalescing: multiple mirror-change events within a single rAF
 * window merge into one `DamageSet`; one paint per frame regardless of
 * input burst. `scheduleFrame` is idempotent.
 *
 * Layer independence (DoD-D-17): cursor-only updates DO NOT re-paint the
 * grid. Selection / IME overlay updates DO NOT re-paint the grid.
 *
 * Perf instrumentation: `PerformanceObserver` + `performance.now()` when
 * available; no-op in jsdom. `perfSummary()` surfaces p50/p95 frame times
 * for the perf-budget tests.
 */

import type { BackendContract } from './backend/BackendContract.js';
import type { CellBuffer } from './CellBuffer.js';
import { DamageSet } from './DamageSet.js';
import type { MirrorSource } from './MirrorSource.js';
import type { CursorState, Row, TerminalModeState } from '../../lib/grid-mirror/types.js';

type FrameClock = (cb: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

export interface RendererOptions {
  /** Override for tests. Defaults to `requestAnimationFrame`. */
  readonly rAF?: FrameClock;
  readonly cancelRAF?: CancelFrame;
  /** High-resolution clock (defaults to `performance.now`). */
  readonly now?: () => number;
  /** Cap on the rolling paint-duration sample buffer. */
  readonly perfSampleCap?: number;
}

interface PaintSample {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly rowsPainted: number;
}

export class Renderer {
  private rafHandle: number | null = null;
  private frozen = false;
  private readonly layerDamage = new DamageSet();
  private readonly subscription: () => void;
  private readonly rAF: FrameClock;
  private readonly cancelRAF: CancelFrame;
  private readonly now: () => number;
  private readonly perfSampleCap: number;
  private samples: PaintSample[] = [];
  private started = false;

  /** Latest cursor snapshot from the mirror; backend consumes on cursor flush. */
  private latestCursor: CursorState | null = null;
  private latestMode: TerminalModeState = {};

  /** Data pulled from the mirror every paint. Callers wire this up via
   *  `setRowFetcher`. The Renderer never imports the mirror directly so
   *  it stays backend-independent. */
  private rowFetcher: (row: number) => Row | undefined = () => undefined;

  constructor(
    private readonly backend: BackendContract,
    private readonly cellBuffer: CellBuffer,
    private readonly source: MirrorSource,
    opts: RendererOptions = {},
  ) {
    this.rAF = opts.rAF ?? defaultRAF;
    this.cancelRAF = opts.cancelRAF ?? defaultCancelRAF;
    this.now = opts.now ?? defaultNow;
    this.perfSampleCap = opts.perfSampleCap ?? 240;
    this.subscription = source.subscribe(() => {
      this.scheduleFrame();
    });
  }

  /** Plumb the row-fetcher. Called by `TerminalCanvas` on mount. */
  setRowFetcher(fetcher: (row: number) => Row | undefined): void {
    this.rowFetcher = fetcher;
  }

  /** Start the rAF loop. Idempotent — safe to call multiple times. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleFrame();
  }

  /** Stop the loop (but keep the subscription so `start()` can resume). */
  stop(): void {
    if (this.rafHandle !== null) {
      this.cancelRAF(this.rafHandle);
      this.rafHandle = null;
    }
    this.started = false;
  }

  /** Freeze — no more paint until a new Renderer is constructed. Used for
   *  degraded read-only mode. */
  freeze(): void {
    this.frozen = true;
    this.stop();
  }

  /** Is the renderer frozen? */
  isFrozen(): boolean {
    return this.frozen;
  }

  /** Mark cursor dirty — called by the TerminalCanvas when cursor state changes. */
  markCursorDirty(cursor: CursorState | null): void {
    this.latestCursor = cursor;
    this.layerDamage.markCursorDirty();
    this.scheduleFrame();
  }

  /** Mark overlay (selection / IME / search) dirty. */
  markOverlayDirty(): void {
    this.layerDamage.markOverlayDirty();
    this.scheduleFrame();
  }

  /** Apply a fresh mode snapshot. Forwarded to the backend. */
  applyMode(mode: TerminalModeState): void {
    this.latestMode = mode;
    this.backend.applyMode(mode);
  }

  /** Paint-duration samples for perf-budget assertions. */
  perfSummary(): {
    p50: number;
    p95: number;
    p99: number;
    count: number;
    avgRows: number;
    maxDurationMs: number;
  } {
    if (this.samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0, avgRows: 0, maxDurationMs: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a.durationMs - b.durationMs);
    const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]?.durationMs ?? 0;
    const total = this.samples.reduce((acc, s) => acc + s.rowsPainted, 0);
    const max = Math.max(...sorted.map((s) => s.durationMs));
    return {
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
      count: this.samples.length,
      avgRows: total / this.samples.length,
      maxDurationMs: max,
    };
  }

  /** Force an immediate tick (for deterministic tests). */
  forceTick(): void {
    if (this.rafHandle !== null) {
      this.cancelRAF(this.rafHandle);
      this.rafHandle = null;
    }
    this.tick(this.now());
  }

  /** Schedule a paint for the next rAF tick. Idempotent — a pending frame
   *  swallows subsequent calls. */
  scheduleFrame(): void {
    if (this.rafHandle !== null) return;
    if (this.frozen) return;
    if (!this.started) return;
    this.rafHandle = this.rAF(this.tick);
  }

  /** Release resources. */
  dispose(): void {
    this.stop();
    this.subscription();
    this.samples = [];
  }

  private readonly tick = (_ts: number): void => {
    this.rafHandle = null;
    if (this.frozen) return;
    const start = this.now();
    const cellDamage = this.cellBuffer.drainDamage();
    const totalCursorDirty = cellDamage.cursorDirty || this.layerDamage.cursorDirty;
    const totalOverlayDirty = cellDamage.overlayDirty || this.layerDamage.overlayDirty;
    const dirtyRowArray = cellDamage.rowArray();
    this.layerDamage.reset();
    if (dirtyRowArray.length === 0 && !totalCursorDirty && !totalOverlayDirty) {
      // Nothing to paint → no sample, no backend call.
      return;
    }
    let rowsPainted = 0;
    // 1. Grid cells (only dirty rows).
    if (dirtyRowArray.length > 0) {
      const rows: Row[] = [];
      for (const r of dirtyRowArray) {
        const row = this.rowFetcher(r);
        if (row) rows.push(row);
      }
      if (rows.length > 0) {
        const damage = new DamageSet();
        damage.addRows(dirtyRowArray);
        this.backend.applyGridDelta(rows, damage);
        rowsPainted = rows.length;
      }
    }
    // 2. Cursor layer.
    if (totalCursorDirty) {
      this.backend.applyCursor(this.latestCursor);
    }
    // 3. Overlay flush.
    this.backend.requestDamageFlush();
    const duration = this.now() - start;
    this.samples.push({ startedAt: start, durationMs: duration, rowsPainted });
    if (this.samples.length > this.perfSampleCap) {
      this.samples.splice(0, this.samples.length - this.perfSampleCap);
    }
  };
}

const defaultRAF: FrameClock = (cb) => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
};

const defaultCancelRAF: CancelFrame = (h) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h);
  else clearTimeout(h as unknown as NodeJS.Timeout);
};

const defaultNow = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};
