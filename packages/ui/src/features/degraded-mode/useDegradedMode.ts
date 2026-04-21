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
import type { HostBridge, SessionId } from '@quanta/host-common';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('degraded-mode');

/** Default stall threshold in ms. Tuned per EPIC-H §4.4.1: 1 s → "stalled". */
const DEFAULT_STALLED_MS = 1_000;
/**
 * Default degraded threshold — effectively disabled for interactive
 * shells. Originally 5 s (EPIC-H §4.4.1), but that assumption treats the
 * PTY as a continuously-streaming source. In a real shell the user
 * routinely sits for 10+ seconds reading output or composing a command,
 * which would wedge a false-positive "engine crashed" banner on a
 * perfectly healthy session (the exact failure this hook is supposed to
 * prevent).
 *
 * Callers that genuinely want silence-based escalation (e.g. a
 * headless CI runner watching a known-chatty stream) can opt in via
 * `degradedAfterMs`. The default is `Number.POSITIVE_INFINITY`, which
 * means the timer only marks `stalled` — the banner is reserved for
 * explicit crash signals (`sidecar_crash_recovered` or `report()`).
 */
const DEFAULT_DEGRADED_MS = Number.POSITIVE_INFINITY;

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
  /**
   * Id of the session the UI currently attributes truth to. When a
   * `pty_exit { signal: 'sidecar_crash_recovered' }` event arrives, we only
   * flip to `degraded` if the event's `sessionId` matches this id — the
   * Tauri-side `process_crash_marker_on_startup` path emits one such event
   * per affected session from the *previous* process run, and those stale
   * notifications must not clobber a freshly-booted session.
   *
   * Pass the active session id (or a getter that returns the latest). Null
   * means "no active session known" — we fall back to the legacy behavior
   * of treating every `sidecar_crash_recovered` event as live.
   */
  readonly currentSessionId?: SessionId | null | (() => SessionId | null);
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
    currentSessionId,
  } = options;

  // `currentSessionId` gate:
  //   - option OMITTED (`undefined`) → legacy behavior (any
  //     `sidecar_crash_recovered` event flips to degraded, irrespective
  //     of session id);
  //   - option PROVIDED (even `null`) → strict filter. An event whose
  //     `sessionId` does not equal the resolver's current return value
  //     is treated as a stale notification (prior-run crash marker
  //     replay that fired before the UI had any session of its own) and
  //     does NOT flip the banner.
  //
  // This distinction matters for the Tauri cold-start path: the sidecar
  // crash marker is replayed BEFORE the UI auto-boots a session, so the
  // active session is still `null` at event-arrival time. Without the
  // "option was provided" discriminator, a caller that wires a nullable
  // active-id (the common case) would silently fall through to the
  // legacy path and pin the banner on.
  // Both the getter AND the "is the option provided" flag live in refs so
  // the subscribe effect's closure always reads the latest value. Without
  // a ref, a prop transition from `undefined → null` (common: caller wires
  // `useState<SessionId | null>()` which starts `undefined` and later
  // becomes `null`) never re-ran the effect (deps omit this), so
  // `hasSessionGate` stayed captured as `false` forever and the strict
  // filter never activated.
  const hasSessionGateRef = useRef<boolean>(currentSessionId !== undefined);
  hasSessionGateRef.current = currentSessionId !== undefined;
  const currentSessionIdRef = useRef<() => SessionId | null>(() => null);
  currentSessionIdRef.current =
    typeof currentSessionId === 'function'
      ? currentSessionId
      : () => (currentSessionId ?? null);

  const [status, setStatus] = useState<DegradedStatus>(() => ({
    state: 'healthy',
    reason: null,
    lastSnapshotAt: now(),
    droppedInputs: 0,
    recoveries: 0,
  }));

  // `null` → stream has not produced its first event yet. Liveness
  // escalation is suppressed while we are in this "pre-first-event" state
  // so that a slow sidecar boot (e.g. 5 s+ compile window in dev) does not
  // look like a crash. Flipped to a real timestamp on the first touch.
  const lastTouchRef = useRef<number | null>(null);
  const stateRef = useRef<DegradedState>('healthy');
  stateRef.current = status.state;

  const touch = useCallback(() => {
    const t = now();
    lastTouchRef.current = t;
    setStatus((prev) => {
      if (prev.state === 'stalled') {
        return { ...prev, state: 'healthy', lastSnapshotAt: t };
      }
      return { ...prev, lastSnapshotAt: t };
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
  // `sidecar-recovered` synthetic exit event flips us to degraded — but
  // only when the event targets the currently-active session.
  useEffect(() => {
    if (!bridge) return;
    const sub = bridge.subscribe((event) => {
      // Sidecar-recovered arrives as a synthetic `pty_exit` with signal
      // `sidecar_crash_recovered` (packages/host-tauri/src-tauri/src/sidecar.rs).
      //
      // The Tauri startup path can emit one such event per
      // `affected_sessions` entry recorded in the on-disk crash marker
      // from a previous process run. Those notifications are about
      // sessions the UI no longer owns — the user already has a fresh
      // session up. Suppress the degraded flip in that case; it would
      // otherwise wedge the banner on over a perfectly healthy new
      // session (RFC §20: degraded must be a live failure signal).
      if (event.kind === 'pty_exit' && event.signal === 'sidecar_crash_recovered') {
        if (hasSessionGateRef.current) {
          // Strict gate. `event.sessionId` must equal the active id; any
          // mismatch — including `active === null` at cold-start, before
          // the UI has spawned its first session — is stale and MUST
          // NOT flip the banner. Otherwise the prior-run crash-marker
          // replay pins the banner on a healthy post-boot session.
          const active = currentSessionIdRef.current();
          if (event.sessionId !== active) {
            log.debug(
              'degraded-mode: ignoring sidecar_crash_recovered for stale session',
              { eventSession: event.sessionId, active },
            );
            // Bridge is responsive — count this as a liveness touch.
            touch();
            return;
          }
        }
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
  //
  // Bootstrap guard: `lastTouchRef.current === null` means we have not
  // observed the stream's first event yet, so we cannot distinguish "slow
  // boot" from "stream silent". Skip escalation until the first touch —
  // RFC §20 requires that degraded represent a verified liveness failure,
  // not a pre-connection wait window.
  useEffect(() => {
    if (disableTimers) return;
    const interval = setInterval(() => {
      const current = stateRef.current;
      if (current === 'degraded') return;
      const lastTouch = lastTouchRef.current;
      if (lastTouch === null) return; // pre-first-event — suppress escalation
      const silent = now() - lastTouch;
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
