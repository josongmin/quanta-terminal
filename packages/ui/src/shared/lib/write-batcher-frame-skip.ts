/**
 * write-batcher-frame-skip — data-safe rendering path with frame-skip
 * backpressure. Builds on top of `write-batcher.ts`'s rAF-coalesced philosophy
 * and adds the Plan 0005 Epic γ policy:
 *
 *   1. **Frame-skip, not drop.** When rendering falls behind, the display may
 *      lag a frame; bytes still flow into the engine on schedule. The UI
 *      thread is not blocked by an inflated chunk — if a single `write()` call
 *      exceeds `maxFeedCpuMs`, the NEXT flush is deferred by one frame so the
 *      browser can paint.
 *
 *   2. **Sidecar flow-control is the primary defense.** When queued bytes
 *      exceed `softCapBytes`, the batcher calls `flowControl.pause()` so the
 *      producing PTY is paused (e.g. via SIGSTOP on the master fd). When the
 *      queue drains below 75 % of the cap, `flowControl.resume()` fires. Both
 *      are idempotent.
 *
 *   3. **Data loss is emergency-only.** If the queue exceeds `hardCapBytes`
 *      (default 256 MiB) AND no flow-control hook is wired, we drop the
 *      OLDEST complete byte-frames from the front of the queue until we fall
 *      back under the hard cap. We NEVER drop mid-sequence: CSI / OSC / DCS /
 *      APC / PM payloads are kept intact so the downstream VT engine never
 *      sees a half-parsed escape.
 *
 *   4. **Byte-frame boundary detector.** The batcher tracks a small FSM across
 *      enqueues so it knows whether the tail of the queue is "inside an
 *      open escape sequence" or not. Flushes yield a prefix ending at the
 *      last safe boundary; any trailing open-sequence bytes stay in the queue
 *      for the next flush. This preserves the existing write-batcher guarantee
 *      (`feed(a); feed(b)` === `feed(concat(a,b))`) under the new drop path.
 *
 * Why both frame-skip AND drop exist:
 *   - Frame-skip alone cannot defend against unbounded memory growth when the
 *     producer vastly outpaces the renderer (`yes | head -c 1G` with rAF
 *     throttled because the tab is backgrounded).
 *   - Drop alone would violate the "데이터 손실은 최대한 금지" policy — losing
 *     bytes corrupts `vim` / `less` / `tmux` sessions.
 *   - Together: frame-skip keeps the UI thread alive under normal load;
 *     sidecar SIGSTOP stops the producer under sustained flood; emergency
 *     drop is a last resort when no SIGSTOP is available.
 *
 * TODO(epic-γ-rust): the `flowControl` injection is currently a pluggable
 * no-op. The Rust sidecar SIGSTOP implementation lands in
 * `packages/host-tauri/src-tauri/src/flow_control.rs` in a later pass. The
 * wiring between PTY → this batcher → `VtEmulator.feed()` lives in
 * `features/session/connect.ts` (γ1 integration).
 */

import { createLogger } from './logger.js';
import { mark, measure } from './perf.js';

const log = createLogger('write-batcher-frame-skip');

// ---------- Public types ----------

export type WriteFn = (data: Uint8Array, done?: () => void) => void;

export interface FlowControl {
  /** Ask the producer to pause (e.g. SIGSTOP on PTY master fd). Idempotent. */
  pause(): void;
  /** Ask the producer to resume. Idempotent. */
  resume(): void;
}

export interface BatcherStats {
  readonly bytesInTotal: number;
  readonly bytesOutTotal: number;
  readonly emergencyDroppedBytesTotal: number;
  readonly queuedBytes: number;
  readonly flushCount: number;
  readonly frameSkipCount: number;
  readonly flowControlPaused: boolean;
}

export interface FrameSkipBatcherOptions {
  /** Underlying write implementation (e.g. `vtEmulator.feed.bind(vt)`). */
  readonly write: WriteFn;
  /**
   * Frame scheduler. Defaults to `requestAnimationFrame`; Node/jsdom falls
   * back to `setTimeout(0)`. Tests inject manual tickers.
   */
  readonly scheduler?: (cb: () => void) => number;
  readonly cancelScheduler?: (id: number) => void;
  /**
   * Soft cap on queued bytes; crossing this triggers `flowControl.pause()`.
   * Default 128 MiB.
   */
  readonly softCapBytes?: number;
  /**
   * Hard cap on queued bytes. Crossed ONLY when no flow-control hook is
   * wired; triggers emergency drop of oldest complete byte-frames. Default
   * 256 MiB.
   */
  readonly hardCapBytes?: number;
  /**
   * Soft CPU budget for a single `write()` call. If exceeded, the next flush
   * is deferred by one frame (frame-skip). Default 8 ms.
   */
  readonly maxFeedCpuMs?: number;
  /** Optional producer flow-control hook. */
  readonly flowControl?: FlowControl;
  /**
   * Telemetry hook; fired whenever a counter bumps and with a queue-size
   * gauge every flush. Labels are sparse.
   */
  readonly onStat?: (name: string, value: number, labels?: Record<string, string>) => void;
  /**
   * Optional override for `performance.now()` — used by tests to inject a
   * deterministic clock for the frame-skip timing check.
   */
  readonly now?: () => number;
}

export interface FrameSkipBatcher {
  enqueue(chunk: Uint8Array): void;
  flush(): void;
  dispose(): void;
  stats(): BatcherStats;
}

// ---------- Byte-frame boundary detector ----------

/**
 * Small FSM mirroring the kinds of open-escape sequences a VT stream can carry.
 *
 *   Ground                not inside any escape sequence.
 *   Esc                   saw ESC (0x1B); next byte classifies.
 *   Csi                   inside `ESC [ ... <final>`; final is 0x40..0x7E.
 *   Osc                   inside `ESC ] ... BEL | ST`.
 *   Dcs | Apc | Pm        `ESC P|_|^ ... ST`. Terminator is ESC \\ or BEL.
 *   EscInString           while inside Osc/Dcs/Apc/Pm, we saw an ESC —
 *                         next byte `\\` (0x5C) closes the string; anything
 *                         else goes back to the string body.
 *
 * We do NOT emit tokens — we only care about "is the current tail byte safe
 * to cut on?". A byte is safe if after consuming it the FSM is back in
 * Ground. The flush splits the queue at the last such byte.
 */
type FsmState = 'Ground' | 'Esc' | 'Csi' | 'Osc' | 'Dcs' | 'Apc' | 'Pm' | 'EscInString';

const ESC = 0x1b;
const BEL = 0x07;

function isCsiFinal(byte: number): boolean {
  // CSI final bytes are 0x40..0x7E.
  return byte >= 0x40 && byte <= 0x7e;
}

/** Step the FSM by one byte, returning the next state. */
function step(state: FsmState, byte: number): FsmState {
  switch (state) {
    case 'Ground':
      return byte === ESC ? 'Esc' : 'Ground';
    case 'Esc':
      if (byte === 0x5b) return 'Csi'; // '['
      if (byte === 0x5d) return 'Osc'; // ']'
      if (byte === 0x50) return 'Dcs'; // 'P'
      if (byte === 0x5f) return 'Apc'; // '_'
      if (byte === 0x5e) return 'Pm'; // '^'
      // Other escape types (charset selects, 7/8, RIS 'c', ST, single-shift…)
      // close immediately — they consume at most the dispatch byte.
      return 'Ground';
    case 'Csi':
      return isCsiFinal(byte) ? 'Ground' : 'Csi';
    case 'Osc':
    case 'Dcs':
    case 'Apc':
    case 'Pm':
      if (byte === BEL) return 'Ground';
      if (byte === ESC) return 'EscInString';
      return state;
    case 'EscInString':
      // Only `ESC \` terminates the string. Anything else is content.
      if (byte === 0x5c) return 'Ground';
      // Per xterm: a stray ESC inside a string aborts the string.
      // We treat it as "still in string" to maximise data preservation and
      // wait for a proper ST/BEL. A pathological DCS without terminator
      // will hold the tail — the soft cap + flow-control + emergency drop
      // are the defenses. The flush still yields everything up to the
      // sequence's first byte.
      return 'Osc'; // promote back to generic string state
  }
}

/**
 * Given a queue of chunks and a starting FSM state, return the BYTE OFFSET
 * within the logical concatenation that is the LAST safe cut point (the byte
 * after which the FSM is in Ground). Returns 0 if no safe point exists.
 *
 * Offset is measured across the full concatenated byte stream (0 = cut
 * nothing; len = cut everything).
 */
function findLastSafeBoundary(
  chunks: readonly Uint8Array[],
  startState: FsmState,
  totalBytes: number,
): { cut: number; endState: FsmState } {
  let state = startState;
  let lastSafeCut = state === 'Ground' ? 0 : 0;
  let absOffset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.byteLength; i += 1) {
      state = step(state, chunk[i]!);
      absOffset += 1;
      if (state === 'Ground') lastSafeCut = absOffset;
    }
  }
  // Safety: lastSafeCut <= totalBytes is an invariant.
  if (lastSafeCut > totalBytes) lastSafeCut = totalBytes;
  return { cut: lastSafeCut, endState: state };
}

// ---------- Defaults ----------

const DEFAULT_SOFT_CAP = 128 * 1024 * 1024;
const DEFAULT_HARD_CAP = 256 * 1024 * 1024;
const DEFAULT_MAX_FEED_CPU_MS = 8;
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

// ---------- Implementation ----------

export function createFrameSkipBatcher(options: FrameSkipBatcherOptions): FrameSkipBatcher {
  const schedule = options.scheduler ?? defaultScheduler;
  const cancel = options.cancelScheduler ?? defaultCancel;
  const softCap = options.softCapBytes ?? DEFAULT_SOFT_CAP;
  const hardCap = options.hardCapBytes ?? DEFAULT_HARD_CAP;
  const maxFeedCpuMs = options.maxFeedCpuMs ?? DEFAULT_MAX_FEED_CPU_MS;
  const now = options.now ?? defaultNow;
  const flowControl = options.flowControl;
  const onStat = options.onStat;

  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  /**
   * FSM state AFTER consuming every byte currently in the queue. Updated
   * incrementally on enqueue. Rewound on flush so the leftover suffix
   * preserves its own in-sequence state.
   */
  let tailState: FsmState = 'Ground';

  let scheduled: number | undefined;
  let disposed = false;
  let flushCount = 0;
  let frameSkipCount = 0;
  /**
   * If true, the NEXT flush should skip an extra frame — implements the
   * frame-skip-on-stall behaviour. Set when a `write()` call exceeds
   * `maxFeedCpuMs`.
   */
  let deferNextFlush = false;
  /**
   * If set, there is a one-frame trampoline in flight (the deferred flush
   * after a long write). Prevents stacking deferrals.
   */
  let deferredScheduled: number | undefined;

  let bytesInTotal = 0;
  let bytesOutTotal = 0;
  let emergencyDroppedBytesTotal = 0;
  let flowPaused = false;
  let lastDropWarnAt = -Infinity;

  function emit(name: string, value: number, labels?: Record<string, string>): void {
    if (!onStat) return;
    try {
      onStat(name, value, labels);
    } catch {
      // Never let telemetry break the data path.
    }
  }

  function maybePause(): void {
    if (!flowControl) return;
    if (flowPaused) return;
    if (queuedBytes > softCap) {
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
    if (queuedBytes <= softCap * RESUME_FRACTION) {
      flowPaused = false;
      try {
        flowControl.resume();
      } catch {
        /* ignore */
      }
      emit('write_batcher.flow_control', 0, { state: 'resumed' });
    }
  }

  function runEmergencyDrop(): void {
    // Only engages when no flow-control is wired and we're past the hard cap.
    if (flowControl) return;
    if (queuedBytes <= hardCap) return;

    // Drop oldest complete byte-frames from the front. "Complete" means: the
    // FSM starting from Ground returns to Ground after consuming them.
    // Walk chunks from the head, stepping the FSM; track the last Ground
    // offset and only drop up to there. This guarantees we never cut a CSI
    // in half.
    let state: FsmState = 'Ground';
    let dropAbs = 0;
    let safeDropAbs = 0;
    const target = queuedBytes - hardCap;
    outer: for (const chunk of queue) {
      for (let i = 0; i < chunk.byteLength; i += 1) {
        state = step(state, chunk[i]!);
        dropAbs += 1;
        if (state === 'Ground') {
          safeDropAbs = dropAbs;
          if (safeDropAbs >= target) break outer;
        }
      }
    }

    if (safeDropAbs <= 0) {
      // Whole queue is one open sequence — can't drop without corrupting it.
      // We hold on (memory cost) and pray the producer finishes the sequence.
      // Warn once per burst so operators know.
      const t = now();
      if (t - lastDropWarnAt > DROP_LOG_DEDUPE_MS) {
        lastDropWarnAt = t;
        log.warn(
          'queue exceeds hardCap but entire buffer is inside one open escape sequence; cannot drop safely',
        );
      }
      return;
    }

    // Trim queue in place up to `safeDropAbs`.
    let remaining = safeDropAbs;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0]!;
      if (head.byteLength <= remaining) {
        remaining -= head.byteLength;
        queue.shift();
      } else {
        queue[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    queuedBytes -= safeDropAbs;
    emergencyDroppedBytesTotal += safeDropAbs;
    emit('write_batcher.bytes_dropped_total', emergencyDroppedBytesTotal);

    const t = now();
    if (t - lastDropWarnAt > DROP_LOG_DEDUPE_MS) {
      lastDropWarnAt = t;
      log.warn('emergency-drop', {
        dropped: safeDropAbs,
        totalDropped: emergencyDroppedBytesTotal,
        remaining: queuedBytes,
      });
    }
  }

  function scheduleFlush(): void {
    if (disposed) return;
    if (scheduled !== undefined || deferredScheduled !== undefined) return;
    scheduled = schedule(() => {
      scheduled = undefined;
      if (disposed) return;
      if (deferNextFlush) {
        // Frame-skip: eat a frame without writing, then re-schedule.
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
    if (disposed) {
      // Still emit a gauge so dispose's final stats read is consistent.
      return;
    }
    if (queue.length === 0) {
      emit('write_batcher.queued_bytes', 0);
      return;
    }

    mark('term.write-start');

    // Find the last safe boundary across the whole queue starting from Ground
    // (the head of the queue is always at Ground — open-sequence suffixes
    // only live at the tail).
    const { cut } = findLastSafeBoundary(queue, 'Ground', queuedBytes);

    if (cut === 0) {
      // Every byte in the queue is part of an unfinished escape. Wait.
      emit('write_batcher.queued_bytes', queuedBytes);
      return;
    }

    // Build the "to-write" prefix and the "hold" suffix.
    let merged: Uint8Array;
    if (cut === queuedBytes && queue.length === 1) {
      merged = queue[0]!;
      queue.length = 0;
      queuedBytes = 0;
    } else {
      merged = new Uint8Array(cut);
      let written = 0;
      let consumed = 0;
      while (consumed < cut && queue.length > 0) {
        const head = queue[0]!;
        const remainingToCut = cut - consumed;
        if (head.byteLength <= remainingToCut) {
          merged.set(head, written);
          written += head.byteLength;
          consumed += head.byteLength;
          queue.shift();
        } else {
          merged.set(head.subarray(0, remainingToCut), written);
          queue[0] = head.subarray(remainingToCut);
          written += remainingToCut;
          consumed += remainingToCut;
        }
      }
      queuedBytes -= cut;
    }
    // After cutting, the head of the remaining queue starts a fresh
    // "open-sequence" suffix. We re-compute its state so subsequent flushes
    // stay correct.
    if (queue.length === 0) {
      tailState = 'Ground';
    } else {
      let s: FsmState = 'Ground';
      for (const chunk of queue) {
        for (let i = 0; i < chunk.byteLength; i += 1) s = step(s, chunk[i]!);
      }
      tailState = s;
    }

    flushCount += 1;
    bytesOutTotal += merged.byteLength;

    const t0 = now();
    try {
      options.write(merged);
    } finally {
      mark('term.write-end');
      measure('term.write', 'term.write-start', 'term.write-end');
    }
    const elapsed = now() - t0;

    if (elapsed > maxFeedCpuMs) {
      deferNextFlush = true;
    }

    emit('write_batcher.bytes_out_total', bytesOutTotal);
    emit('write_batcher.queued_bytes', queuedBytes);

    // If we still have residue, schedule another flush.
    if (queuedBytes > 0) scheduleFlush();

    maybeResume();
  }

  return {
    enqueue(chunk: Uint8Array): void {
      if (disposed) return;
      if (chunk.byteLength === 0) return;
      queue.push(chunk);
      queuedBytes += chunk.byteLength;
      bytesInTotal += chunk.byteLength;

      // Incrementally advance the tail-state so the next flush can find a
      // safe boundary in O(n) over the NEW bytes (the full-queue walk inside
      // flush() is still O(n) over the whole queue; see note there).
      let s: FsmState = tailState;
      for (let i = 0; i < chunk.byteLength; i += 1) s = step(s, chunk[i]!);
      tailState = s;

      emit('write_batcher.bytes_in_total', bytesInTotal);

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
      // Preserve counter values so post-dispose stats() is stable.
      queue.length = 0;
      queuedBytes = 0;
    },
    stats(): BatcherStats {
      return {
        bytesInTotal,
        bytesOutTotal,
        emergencyDroppedBytesTotal,
        queuedBytes,
        flushCount,
        frameSkipCount,
        flowControlPaused: flowPaused,
      };
    },
  };
}

// ---------- Internal exports for testing only ----------

/**
 * Test-only export. Not part of the public API. Used by the spec to assert
 * that the boundary detector correctly classifies CSI / OSC / DCS tails.
 */
export const __testing = {
  step,
  findLastSafeBoundary,
};
