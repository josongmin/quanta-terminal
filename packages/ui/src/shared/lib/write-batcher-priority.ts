/**
 * write-batcher-priority — Plan 0005 P2-C.
 *
 * Priority-aware variant of `write-batcher-frame-skip.ts`. Same public
 * contract (`FrameSkipBatcher`), same frame-skip + sidecar-flow-control +
 * emergency-drop safety net — but internally the queue is split into three
 * lanes keyed by `PriorityClass`:
 *
 *   1. control-lane    (lossless; OSC 133 / OSC 7 / OSC 8 / DECSET /
 *                       synchronized-update DCS / ENQ / verbose-gate marker)
 *   2. data-lane       (lossy; merges `visible` + `scrollback` byte frames,
 *                       tagged per-frame so the drop policy can subsample
 *                       scrollback first and only reach into visible when
 *                       hardCap pressure persists)
 *   3. verbose-lane    (highest drop priority; always dropped before data)
 *
 * Drop order under sustained hardCap pressure:
 *
 *   verbose  →  scrollback  →  visible (subsample to ~30 Hz)  →  [never] control
 *
 * Byte-accounting invariant — ALL classes are counted:
 *
 *   bytesInTotal === bytesOutTotal
 *                 + droppedByClass.control  (always 0)
 *                 + droppedByClass.visible
 *                 + droppedByClass.scrollback
 *                 + droppedByClass.verbose
 *                 + queuedBytes
 *
 * Feature-flag gate
 * -----------------
 * This batcher is NOT the default. `features/session/engine.ts` continues
 * to wire `createFrameSkipBatcher` (P0 wave-3 behaviour). The priority
 * variant is opt-in via `flag.priorityBackpressure`; the session-connect
 * wiring reads the flag at spawn time and picks whichever batcher is
 * active. See `docs/plans/0005-sota-convergence/epic-gamma-*.md` for the
 * rollout plan.
 *
 * Relationship to the base batcher
 * --------------------------------
 * We do NOT extend the base class by inheritance (there is no class).
 * Instead we reuse the FSM-based `findLastSafeBoundary` / `step` helpers
 * from `write-batcher-frame-skip.ts` via the `__testing` export — the
 * priority queue only adds per-lane bookkeeping on top of the same
 * Ground-aligned boundary cut.
 */

import {
  classifyByteFrame,
  type ClassifyContext,
  type PriorityClass,
} from './backpressure-classifier.js';
import { createLogger } from './logger.js';
import { mark, measure } from './perf.js';
import type {
  BatcherStats,
  FlowControl,
  FrameSkipBatcher,
  FrameSkipBatcherOptions,
  WriteFn,
} from './write-batcher-frame-skip.js';
import { __testing as frameSkipInternals } from './write-batcher-frame-skip.js';

const log = createLogger('write-batcher-priority');

// ---------- Public types ----------

export interface PriorityBatcherStats extends BatcherStats {
  /** Per-class dropped-bytes counters. `control` is always 0. */
  readonly droppedByClass: Readonly<Record<PriorityClass, number>>;
  /** Per-class bytes-in counters (useful for drop-rate alerts). */
  readonly bytesInByClass: Readonly<Record<PriorityClass, number>>;
}

export interface PriorityFrameSkipBatcherOptions extends FrameSkipBatcherOptions {
  /**
   * Override the classifier. The default reads from a small
   * `ClassifyContext` the batcher maintains (viewport, cursorY, alt-screen
   * guess, verbose gate). Tests inject a deterministic classifier to
   * exercise specific drop paths.
   */
  readonly classify?: (
    bytes: Uint8Array,
    ctx: ClassifyContext,
  ) => PriorityClass;
  /**
   * Visible-lane subsample rate in Hz. When set, frames tagged `visible`
   * are coalesced into at most N writes per second under pressure. Default
   * 30 Hz — aligns with the frame-skip batcher's CPU budget.
   */
  readonly visibleSubsampleHz?: number;
  /**
   * Context hook: batcher calls this at frame-boundary time to refresh the
   * alt-screen / cursor / viewport hints fed into the classifier. Optional;
   * omitted tests pin context to a static value.
   */
  readonly getContext?: () => ClassifyContext;
}

export interface PriorityFrameSkipBatcher extends FrameSkipBatcher {
  /** Priority-aware stats. */
  stats(): PriorityBatcherStats;
}

// ---------- Lane record ----------

interface LaneFrame {
  readonly klass: PriorityClass;
  readonly bytes: Uint8Array;
}

// ---------- Defaults ----------

const DEFAULT_SOFT_CAP = 128 * 1024 * 1024;
const DEFAULT_HARD_CAP = 256 * 1024 * 1024;
const DEFAULT_MAX_FEED_CPU_MS = 8;
const DEFAULT_VISIBLE_SUBSAMPLE_HZ = 30;
const RESUME_FRACTION = 0.75;
const DROP_LOG_DEDUPE_MS = 1000;

function defaultScheduler(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(cb, 0) as unknown as number;
}

function defaultCancel(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function defaultContext(): ClassifyContext {
  return {
    inAltScreen: false,
    cursorY: 0,
    viewportRows: 24,
    verboseGateOpen: false,
  };
}

// ---------- Implementation ----------

export function createPriorityFrameSkipBatcher(
  options: PriorityFrameSkipBatcherOptions,
): PriorityFrameSkipBatcher {
  const schedule = options.scheduler ?? defaultScheduler;
  const cancel = options.cancelScheduler ?? defaultCancel;
  const softCap = options.softCapBytes ?? DEFAULT_SOFT_CAP;
  const hardCap = options.hardCapBytes ?? DEFAULT_HARD_CAP;
  const maxFeedCpuMs = options.maxFeedCpuMs ?? DEFAULT_MAX_FEED_CPU_MS;
  const visibleSubsampleHz =
    options.visibleSubsampleHz ?? DEFAULT_VISIBLE_SUBSAMPLE_HZ;
  const visibleFrameMinMs = 1000 / Math.max(1, visibleSubsampleHz);
  const now = options.now ?? defaultNow;
  const flowControl: FlowControl | undefined = options.flowControl;
  const onStat = options.onStat;
  const classify = options.classify ?? classifyByteFrame;
  const getContext = options.getContext ?? defaultContext;
  const write: WriteFn = options.write;

  // Three parallel queues, with control LOSSLESS. We preserve insertion
  // order within each lane; at flush time we emit control first, then
  // interleave data (visible/scrollback) by insertion order, then verbose.
  // This ordering keeps protocol state ahead of the data it affects
  // (e.g. an OSC 133 "prompt start" before the prompt text that follows).
  const controlQueue: LaneFrame[] = [];
  const dataQueue: LaneFrame[] = []; // visible + scrollback mixed, insertion-ordered
  const verboseQueue: LaneFrame[] = [];

  let controlBytes = 0;
  let dataBytes = 0;
  let verboseBytes = 0;

  // Partial-sequence buffer for the boundary detector. If `enqueue` receives
  // a chunk that ends mid-escape, we hold the suffix until the next chunk
  // completes it. Mirrors the base batcher's tail-state.
  const partial: Uint8Array[] = [];
  let partialBytes = 0;
  let partialState: ReturnType<typeof frameSkipInternals.step> = 'Ground';

  // Frame-skip machinery.
  let scheduled: number | undefined;
  let deferredScheduled: number | undefined;
  let disposed = false;
  let deferNextFlush = false;
  let flushCount = 0;
  let frameSkipCount = 0;

  // Counters.
  let bytesInTotal = 0;
  let bytesOutTotal = 0;
  let emergencyDroppedBytesTotal = 0;
  const bytesInByClass: Record<PriorityClass, number> = {
    control: 0,
    visible: 0,
    scrollback: 0,
    verbose: 0,
  };
  const droppedByClass: Record<PriorityClass, number> = {
    control: 0,
    visible: 0,
    scrollback: 0,
    verbose: 0,
  };

  let flowPaused = false;
  let lastDropWarnAt = -Infinity;
  let lastVisibleWriteAt = -Infinity;

  function totalQueued(): number {
    return controlBytes + dataBytes + verboseBytes + partialBytes;
  }

  function emit(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void {
    if (!onStat) return;
    try {
      onStat(name, value, labels);
    } catch {
      // Telemetry never breaks the data path.
    }
  }

  function emitDropRate(klass: PriorityClass): void {
    emit('backpressure.drop_rate_by_class', droppedByClass[klass], {
      class: klass,
    });
  }

  function maybePause(): void {
    if (!flowControl) return;
    if (flowPaused) return;
    if (totalQueued() > softCap) {
      flowPaused = true;
      try {
        flowControl.pause();
      } catch {
        /* ignore */
      }
      emit('write_batcher.flow_control', 1, { state: 'paused' });
    }
  }

  function maybeResume(): void {
    if (!flowControl) return;
    if (!flowPaused) return;
    if (totalQueued() <= softCap * RESUME_FRACTION) {
      flowPaused = false;
      try {
        flowControl.resume();
      } catch {
        /* ignore */
      }
      emit('write_batcher.flow_control', 0, { state: 'resumed' });
    }
  }

  /**
   * Under hardCap pressure and no flow-control wired, drop entire frames
   * in priority order:
   *   verbose (all) → scrollback (oldest first) → visible (oldest first).
   * control is never touched.
   *
   * Frames are whole byte-frames (chunks that already sit at Ground start
   * and Ground end because we classify them at enqueue time); dropping one
   * never corrupts a CSI/OSC.
   */
  function runEmergencyDrop(): void {
    if (flowControl) return;
    if (totalQueued() <= hardCap) return;

    // Phase 1: dump verbose.
    while (totalQueued() > hardCap && verboseQueue.length > 0) {
      const frame = verboseQueue.shift()!;
      verboseBytes -= frame.bytes.byteLength;
      droppedByClass.verbose += frame.bytes.byteLength;
      emergencyDroppedBytesTotal += frame.bytes.byteLength;
    }

    // Phase 2: dump scrollback (drop oldest scrollback frames first;
    // visible and control frames in the data queue are left alone).
    if (totalQueued() > hardCap) {
      for (let i = 0; i < dataQueue.length && totalQueued() > hardCap; ) {
        const frame = dataQueue[i]!;
        if (frame.klass === 'scrollback') {
          dataQueue.splice(i, 1);
          dataBytes -= frame.bytes.byteLength;
          droppedByClass.scrollback += frame.bytes.byteLength;
          emergencyDroppedBytesTotal += frame.bytes.byteLength;
          // don't advance i — the next frame shifted in.
        } else {
          i += 1;
        }
      }
    }

    // Phase 3: dump visible (oldest first) ONLY as last resort. Subsample
    // kicks in earlier (see flushLane) — this branch is for the pathological
    // case where visible traffic alone breaches hardCap.
    if (totalQueued() > hardCap) {
      for (let i = 0; i < dataQueue.length && totalQueued() > hardCap; ) {
        const frame = dataQueue[i]!;
        if (frame.klass === 'visible') {
          dataQueue.splice(i, 1);
          dataBytes -= frame.bytes.byteLength;
          droppedByClass.visible += frame.bytes.byteLength;
          emergencyDroppedBytesTotal += frame.bytes.byteLength;
        } else {
          i += 1;
        }
      }
    }

    // control is never dropped. If we're still over hardCap, the queue is
    // entirely control bytes (extremely unlikely in practice — e.g. a
    // prompt storm) and we hold on at the memory cost with a warn dedupe.
    if (totalQueued() > hardCap) {
      const t = now();
      if (t - lastDropWarnAt > DROP_LOG_DEDUPE_MS) {
        lastDropWarnAt = t;
        log.warn(
          'priority batcher: totalQueued exceeds hardCap after drops; queue is all control or partial',
          { totalQueued: totalQueued(), hardCap },
        );
      }
      return;
    }

    emit('write_batcher.bytes_dropped_total', emergencyDroppedBytesTotal);
    emitDropRate('verbose');
    emitDropRate('scrollback');
    emitDropRate('visible');
    emitDropRate('control');

    const t = now();
    if (t - lastDropWarnAt > DROP_LOG_DEDUPE_MS) {
      lastDropWarnAt = t;
      log.warn('priority emergency-drop', {
        droppedVerbose: droppedByClass.verbose,
        droppedScrollback: droppedByClass.scrollback,
        droppedVisible: droppedByClass.visible,
        totalDropped: emergencyDroppedBytesTotal,
        remaining: totalQueued(),
      });
    }
  }

  /**
   * Split an incoming chunk at the last safe byte-frame boundary. Tail
   * stays in `partial` for the next enqueue. The safe-prefix is returned.
   */
  function carveSafeBytes(chunk: Uint8Array): Uint8Array | null {
    // Append chunk to partial buffer for the FSM walk.
    partial.push(chunk);
    partialBytes += chunk.byteLength;

    // Walk the ENTIRE partial buffer from the state we carried.
    const { cut, endState } = frameSkipInternals.findLastSafeBoundary(
      partial,
      partialState,
      partialBytes,
    );
    partialState = endState;

    if (cut === 0) {
      return null; // still mid-sequence; hold for next enqueue.
    }

    // Build safe prefix from partial[0..cut]. Trim `partial` in place to
    // the residue (cut..end).
    let safe: Uint8Array;
    if (cut === partialBytes && partial.length === 1) {
      safe = partial[0]!;
      partial.length = 0;
      partialBytes = 0;
    } else {
      safe = new Uint8Array(cut);
      let written = 0;
      let consumed = 0;
      while (consumed < cut && partial.length > 0) {
        const head = partial[0]!;
        const remaining = cut - consumed;
        if (head.byteLength <= remaining) {
          safe.set(head, written);
          written += head.byteLength;
          consumed += head.byteLength;
          partial.shift();
        } else {
          safe.set(head.subarray(0, remaining), written);
          partial[0] = head.subarray(remaining);
          written += remaining;
          consumed += remaining;
        }
      }
      partialBytes -= cut;
    }
    // `partialState` was set to endState which reflects AFTER the full walk.
    // After cutting, the residue re-starts a fresh walk; recompute state.
    if (partial.length === 0) {
      partialState = 'Ground';
    } else {
      let s: ReturnType<typeof frameSkipInternals.step> = 'Ground';
      for (const c of partial) {
        for (let i = 0; i < c.byteLength; i += 1) {
          s = frameSkipInternals.step(s, c[i]!);
        }
      }
      partialState = s;
    }
    return safe;
  }

  /**
   * Enqueue a classified safe-prefix frame into its lane. The frame itself
   * may span multiple classifier-level byte-frames — we keep a single
   * classification per *chunk after boundary carving* to match the base
   * batcher's 1-chunk-per-flush-cycle behaviour.
   */
  function placeFrame(bytes: Uint8Array, klass: PriorityClass): void {
    bytesInByClass[klass] += bytes.byteLength;
    if (klass === 'control') {
      controlQueue.push({ klass, bytes });
      controlBytes += bytes.byteLength;
    } else if (klass === 'verbose') {
      verboseQueue.push({ klass, bytes });
      verboseBytes += bytes.byteLength;
    } else {
      // visible + scrollback share the same queue to preserve insertion
      // order across classes (prevents visible-before-scrollback reordering
      // when a single OSC arrives inside a stream of logs).
      dataQueue.push({ klass, bytes });
      dataBytes += bytes.byteLength;
    }
  }

  function scheduleFlush(): void {
    if (disposed) return;
    if (scheduled !== undefined || deferredScheduled !== undefined) return;
    scheduled = schedule(() => {
      scheduled = undefined;
      if (disposed) return;
      if (deferNextFlush) {
        deferNextFlush = false;
        frameSkipCount += 1;
        emit('write_batcher.frame_skip_total', frameSkipCount);
        deferredScheduled = schedule(() => {
          deferredScheduled = undefined;
          if (disposed) return;
          flush();
        });
        return;
      }
      flush();
    });
  }

  function flush(): void {
    if (disposed) return;
    if (
      controlQueue.length === 0 &&
      dataQueue.length === 0 &&
      verboseQueue.length === 0
    ) {
      emit('write_batcher.queued_bytes', totalQueued());
      return;
    }

    mark('term.write-start');

    // Drain order: control → data → verbose. Within each lane we flush the
    // whole queue in one concatenated write so the VtEmulator sees a
    // contiguous byte stream per lane.
    const t0 = now();
    const now_ = t0;

    let elapsed = 0;
    let wroteAnything = false;

    // 1. Control — always.
    if (controlQueue.length > 0) {
      const merged = mergeLane(controlQueue);
      controlQueue.length = 0;
      controlBytes = 0;
      writeSafely(write, merged);
      bytesOutTotal += merged.byteLength;
      wroteAnything = true;
    }

    // 2. Data — visible/scrollback interleaved. Under pressure, apply the
    //    visible-subsample rate limit: if we wrote visible bytes within the
    //    last `visibleFrameMinMs`, defer visible frames to the next flush.
    if (dataQueue.length > 0) {
      const underLoad = totalQueued() > softCap;
      let outBytes = 0;
      const keepFrames: LaneFrame[] = [];
      const parts: Uint8Array[] = [];
      let droppedVisibleThisFlush = 0;
      let droppedScrollbackThisFlush = 0;
      for (const frame of dataQueue) {
        if (frame.klass === 'visible') {
          if (
            underLoad &&
            now_ - lastVisibleWriteAt < visibleFrameMinMs &&
            wroteAnything === false &&
            parts.length === 0
          ) {
            // Subsample: hold this frame for next flush. Keep in queue.
            keepFrames.push(frame);
            continue;
          }
          parts.push(frame.bytes);
          outBytes += frame.bytes.byteLength;
          dataBytes -= frame.bytes.byteLength;
          lastVisibleWriteAt = now_;
        } else if (frame.klass === 'scrollback') {
          if (underLoad) {
            // Under pressure, subsample scrollback aggressively: keep only
            // every 2nd scrollback frame. The dropped ones count against
            // the scrollback drop-rate metric so the operator can see
            // subsample activity even without hardCap emergency-drops.
            if (droppedScrollbackThisFlush % 2 === 1) {
              droppedByClass.scrollback += frame.bytes.byteLength;
              emergencyDroppedBytesTotal += frame.bytes.byteLength;
              dataBytes -= frame.bytes.byteLength;
              droppedScrollbackThisFlush += 1;
              continue;
            }
            droppedScrollbackThisFlush += 1;
          }
          parts.push(frame.bytes);
          outBytes += frame.bytes.byteLength;
          dataBytes -= frame.bytes.byteLength;
        } else {
          // Shouldn't happen (control goes to controlQueue) — but be safe.
          parts.push(frame.bytes);
          outBytes += frame.bytes.byteLength;
          dataBytes -= frame.bytes.byteLength;
        }
        void droppedVisibleThisFlush;
      }
      dataQueue.length = 0;
      for (const kf of keepFrames) {
        dataQueue.push(kf);
        dataBytes += kf.bytes.byteLength;
      }
      if (parts.length > 0) {
        const merged = concatParts(parts, outBytes);
        writeSafely(write, merged);
        bytesOutTotal += merged.byteLength;
        wroteAnything = true;
      }
    }

    // 3. Verbose — drop first under pressure; otherwise write through.
    if (verboseQueue.length > 0) {
      const overSoftCap = totalQueued() > softCap;
      if (overSoftCap) {
        // Drop all verbose under pressure, log once per burst.
        let droppedHere = 0;
        for (const frame of verboseQueue) {
          droppedByClass.verbose += frame.bytes.byteLength;
          emergencyDroppedBytesTotal += frame.bytes.byteLength;
          droppedHere += frame.bytes.byteLength;
        }
        verboseQueue.length = 0;
        verboseBytes = 0;
        if (droppedHere > 0) {
          emitDropRate('verbose');
        }
      } else {
        const merged = mergeLane(verboseQueue);
        verboseQueue.length = 0;
        verboseBytes = 0;
        writeSafely(write, merged);
        bytesOutTotal += merged.byteLength;
        wroteAnything = true;
      }
    }

    elapsed = now() - t0;
    if (elapsed > maxFeedCpuMs) {
      deferNextFlush = true;
    }

    void wroteAnything;
    mark('term.write-end');
    measure('term.write', 'term.write-start', 'term.write-end');

    flushCount += 1;

    emit('write_batcher.bytes_out_total', bytesOutTotal);
    emit('write_batcher.queued_bytes', totalQueued());
    emitDropRate('control'); // always 0, but visible in the telemetry feed
    emitDropRate('visible');
    emitDropRate('scrollback');
    emitDropRate('verbose');

    if (
      controlQueue.length > 0 ||
      dataQueue.length > 0 ||
      verboseQueue.length > 0
    ) {
      scheduleFlush();
    }

    maybeResume();
  }

  return {
    enqueue(chunk: Uint8Array): void {
      if (disposed) return;
      if (chunk.byteLength === 0) return;

      bytesInTotal += chunk.byteLength;
      emit('write_batcher.bytes_in_total', bytesInTotal);

      const safe = carveSafeBytes(chunk);
      if (safe !== null && safe.byteLength > 0) {
        const klass = classify(safe, getContext());
        placeFrame(safe, klass);
      }

      maybePause();
      runEmergencyDrop();

      scheduleFlush();
    },
    flush(): void {
      flush();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (scheduled !== undefined) {
        cancel(scheduled);
        scheduled = undefined;
      }
      if (deferredScheduled !== undefined) {
        cancel(deferredScheduled);
        deferredScheduled = undefined;
      }
      controlQueue.length = 0;
      dataQueue.length = 0;
      verboseQueue.length = 0;
      controlBytes = 0;
      dataBytes = 0;
      verboseBytes = 0;
      partial.length = 0;
      partialBytes = 0;
      partialState = 'Ground';
    },
    stats(): PriorityBatcherStats {
      return {
        bytesInTotal,
        bytesOutTotal,
        emergencyDroppedBytesTotal,
        queuedBytes: totalQueued(),
        flushCount,
        frameSkipCount,
        flowControlPaused: flowPaused,
        droppedByClass: { ...droppedByClass },
        bytesInByClass: { ...bytesInByClass },
      };
    },
  };
}

// ---------- Helpers ----------

function mergeLane(frames: readonly LaneFrame[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.bytes.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f.bytes, off);
    off += f.bytes.byteLength;
  }
  return out;
}

function concatParts(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function writeSafely(write: WriteFn, bytes: Uint8Array): void {
  try {
    write(bytes);
  } catch (err) {
    log.warn('priority batcher write() threw; continuing', err);
  }
}

// ---------- Test-only exports ----------

export const __testing = {
  DEFAULT_VISIBLE_SUBSAMPLE_HZ,
};
