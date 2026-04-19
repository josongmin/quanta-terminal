/**
 * useDegradedMode — observes engine liveness and exposes a degraded state.
 *
 * Contract (RFC §20 + EPIC-H §4.4.1):
 *   - `healthy`  — events arriving normally.
 *   - `stalled`  — no event for > 1 s; a transient UI hint, not a banner.
 *   - `degraded` — the engine is considered dead. Banner shown. Input
 *                  disabled. Last snapshot preserved.
 *
 * Triggers for the degraded state:
 *   1. The host bridge emits a `sidecar-recovered` event (ADR 0004). The
 *      recovered payload carries a synthetic `pty_exit` with `signal:
 *      "sidecar_crash_recovered"` — the event stream is how the UI learns
 *      the sidecar died, even though it came back up.
 *   2. An optional `liveness` callback reports the stream as silent for
 *      longer than the caller's tolerance.
 *
 * Recovery from degraded is explicit — the caller invokes `recover()` after
 * a successful `Restart session` RPC. There is no auto-recovery: RFC §20
 * forbids flipping back to healthy without a verified fresh engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostBridge } from '@quanta/host-common';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('degraded-mode');

/** Default stall threshold in ms. Tuned per EPIC-H §4.4.1: 1 s → "stalled". */
const DEFAULT_STALLED_MS = 1_000;
/** Default degraded threshold — 5 s silence collapses to banner. */
const DEFAULT_DEGRADED_MS = 5_000;

export type DegradedState = 'healthy' | 'stalled' | 'degraded';

export interface DegradedStatus {
  readonly state: DegradedState;
  readonly reason: string | null;
  readonly lastSnapshotAt: number;
  readonly droppedInputs: number;
  readonly recoveries: number;
}

export interface UseDegradedModeOptions {
  /**
   * Host bridge. Optional for tests; when omitted we simply don't subscribe
   * to sidecar-recovered events and rely on caller-driven liveness signals.
   */
  readonly bridge?: HostBridge | null;
  readonly stalledAfterMs?: number;
  readonly degradedAfterMs?: number;
  /** Injected `now()` — supports deterministic tests. */
  readonly now?: () => number;
  /** True → disable the internal timer (tests drive state directly). */
  readonly disableTimers?: boolean;
}

export interface DegradedHandle extends DegradedStatus {
  /** Mark the stream as alive — called on every event arrival. */
  readonly touch: () => void;
  /** Force the degraded banner; reason is surfaced in the dataset. */
  readonly report: (reason: string) => void;
  /** Complete the recovery path and flip back to `healthy`. */
  readonly recover: () => void;
  /** Bump the telemetry counter when input is dropped during degraded state. */
  readonly incrementDroppedInput: () => void;
}

/**
 * Subscribe to the host bridge's event stream (every event is a liveness
 * touch) and the Tauri-level `sidecar-recovered` topic. Tests usually pass
 * `bridge: null` and drive state explicitly via `report` / `touch`.
 */
export function useDegradedMode(options: UseDegradedModeOptions = {}): DegradedHandle {
  const {
    bridge = null,
    stalledAfterMs = DEFAULT_STALLED_MS,
    degradedAfterMs = DEFAULT_DEGRADED_MS,
    now = () => Date.now(),
    disableTimers = false,
  } = options;

  const [status, setStatus] = useState<DegradedStatus>(() => ({
    state: 'healthy',
    reason: null,
    lastSnapshotAt: now(),
    droppedInputs: 0,
    recoveries: 0,
  }));

  const lastTouchRef = useRef<number>(now());
  const stateRef = useRef<DegradedState>('healthy');
  stateRef.current = status.state;

  const touch = useCallback(() => {
    lastTouchRef.current = now();
    setStatus((prev) => {
      if (prev.state === 'stalled') {
        return { ...prev, state: 'healthy', lastSnapshotAt: lastTouchRef.current };
      }
      return { ...prev, lastSnapshotAt: lastTouchRef.current };
    });
  }, [now]);

  const report = useCallback(
    (reason: string) => {
      log.warn('degraded-mode: engine declared dead', reason);
      setStatus((prev) => ({
        ...prev,
        state: 'degraded',
        reason,
        // Preserve whatever lastSnapshotAt we had — the UI wants to know
        // WHEN we last saw truth, not when we noticed the death.
      }));
    },
    [],
  );

  const recover = useCallback(() => {
    setStatus((prev) => ({
      state: 'healthy',
      reason: null,
      lastSnapshotAt: now(),
      droppedInputs: prev.droppedInputs,
      recoveries: prev.recoveries + 1,
    }));
    lastTouchRef.current = now();
  }, [now]);

  const incrementDroppedInput = useCallback(() => {
    setStatus((prev) => ({ ...prev, droppedInputs: prev.droppedInputs + 1 }));
  }, []);

  // Subscribe to the host bridge: any event is a liveness touch. The
  // `sidecar-recovered` synthetic exit event flips us to degraded.
  useEffect(() => {
    if (!bridge) return;
    const sub = bridge.subscribe((event) => {
      // Sidecar-recovered arrives as a synthetic `pty_exit` with signal
      // `sidecar_crash_recovered` (packages/host-tauri/src-tauri/src/sidecar.rs).
      if (event.kind === 'pty_exit' && event.signal === 'sidecar_crash_recovered') {
        report('engine_crashed');
        return;
      }
      touch();
    });
    return () => sub.unsubscribe();
  }, [bridge, touch, report]);

  // Liveness timer: if we haven't touched in `stalledAfterMs`, drop to
  // `stalled`; if silent longer than `degradedAfterMs`, escalate to
  // `degraded`.
  useEffect(() => {
    if (disableTimers) return;
    const interval = setInterval(() => {
      const silent = now() - lastTouchRef.current;
      const current = stateRef.current;
      if (current === 'degraded') return;
      if (silent >= degradedAfterMs) {
        log.warn('degraded-mode: stream silent for', silent, 'ms; promoting to degraded');
        setStatus((prev) => ({ ...prev, state: 'degraded', reason: 'stream_silent' }));
        return;
      }
      if (silent >= stalledAfterMs && current !== 'stalled') {
        setStatus((prev) => (prev.state === 'healthy' ? { ...prev, state: 'stalled' } : prev));
      }
    }, Math.min(stalledAfterMs, 500));
    return () => clearInterval(interval);
  }, [disableTimers, stalledAfterMs, degradedAfterMs, now]);

  return {
    ...status,
    touch,
    report,
    recover,
    incrementDroppedInput,
  };
}
