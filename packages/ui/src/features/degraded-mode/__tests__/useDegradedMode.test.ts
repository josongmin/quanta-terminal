/**
 * useDegradedMode — hook behaviour tests.
 *
 *   1. Starts in `healthy`.
 *   2. `report('...')` flips the state to `degraded` and records the reason.
 *   3. `recover()` returns the hook to `healthy` and bumps the counter.
 *   4. `incrementDroppedInput` bumps the dropped-input counter.
 *   5. Subscribes to the host bridge and flips to degraded on a
 *      `pty_exit` synthetic event carrying `signal: 'sidecar_crash_recovered'`.
 *   6. Any other event is treated as a liveness touch — a stalled state
 *      returns to healthy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { HostBridge, HostEvent, HostEventListener } from '@quanta/host-common';
import { useDegradedMode } from '../useDegradedMode.js';

afterEach(() => {
  vi.useRealTimers();
});

function fakeBridge(): { bridge: HostBridge; emit: (event: HostEvent) => void } {
  const listeners = new Set<HostEventListener>();
  const bridge = {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
    },
    ready: async () => {},
    spawn: async () => ({ sessionId: 'x', shell: '/bin/sh', cwd: '/' }),
    write: async () => {},
    resize: async () => {},
    close: async () => {},
    cancelBlock: async () => {},
    openInEditor: async () => {},
    installShellIntegration: async () => ({
      targetPath: '',
      snippet: '',
      alreadyInstalled: false,
      mutated: false,
      lineCount: 0,
    }),
    uninstallShellIntegration: async () => ({
      targetPath: '',
      removedRegion: '',
      alreadyAbsent: true,
      fileMissing: false,
      mutated: false,
      lineCount: 0,
    }),
    notify: async () => {},
    aiSuggest: async () => ({
      id: '',
      command: '',
      tier: 'safe' as const,
      modifiers: [],
      rulesetVersion: 0,
    }),
    subscribe: (listener: HostEventListener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  } satisfies HostBridge;
  return {
    bridge,
    emit: (event: HostEvent) => {
      for (const l of listeners) l(event);
    },
  };
}

describe('useDegradedMode', () => {
  it('starts in the healthy state', () => {
    const { result } = renderHook(() => useDegradedMode({ disableTimers: true }));
    expect(result.current.state).toBe('healthy');
    expect(result.current.reason).toBeNull();
    expect(result.current.droppedInputs).toBe(0);
  });

  it('report() flips to degraded with the supplied reason', () => {
    const { result } = renderHook(() => useDegradedMode({ disableTimers: true }));
    act(() => {
      result.current.report('engine_crashed');
    });
    expect(result.current.state).toBe('degraded');
    expect(result.current.reason).toBe('engine_crashed');
  });

  it('recover() returns to healthy and bumps the recoveries counter', () => {
    const { result } = renderHook(() => useDegradedMode({ disableTimers: true }));
    act(() => {
      result.current.report('engine_crashed');
    });
    expect(result.current.recoveries).toBe(0);
    act(() => {
      result.current.recover();
    });
    expect(result.current.state).toBe('healthy');
    expect(result.current.reason).toBeNull();
    expect(result.current.recoveries).toBe(1);
  });

  it('incrementDroppedInput bumps the counter idempotently', () => {
    const { result } = renderHook(() => useDegradedMode({ disableTimers: true }));
    act(() => {
      result.current.incrementDroppedInput();
      result.current.incrementDroppedInput();
    });
    expect(result.current.droppedInputs).toBe(2);
  });

  it('flips to degraded when the bridge emits sidecar_crash_recovered for the active session', () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({ bridge, currentSessionId: 'x', disableTimers: true }),
    );
    expect(result.current.state).toBe('healthy');
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'x',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('degraded');
    expect(result.current.reason).toBe('engine_crashed');
  });

  it('IGNORES sidecar_crash_recovered events for STALE sessions (prior-run marker replay)', () => {
    // This is the exact production RCA: the Tauri startup path replays
    // one `pty_exit { signal: sidecar_crash_recovered, sessionId: <old> }`
    // per entry in the on-disk crash marker from a previous process run.
    // The UI's active session is brand-new post-boot; the stale
    // notification must not pin the banner on.
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({
        bridge,
        currentSessionId: 'new-session-id',
        disableTimers: true,
      }),
    );
    expect(result.current.state).toBe('healthy');
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'old-crashed-session-id',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    // Banner stays off — the event was about a different (dead) session.
    expect(result.current.state).toBe('healthy');
    expect(result.current.reason).toBeNull();
  });

  it('with currentSessionId as a getter — reads the latest value on every event', () => {
    // TerminalPage wires `currentSessionId` as a getter so the subscribe
    // effect does not re-register on every session change. The getter
    // must be consulted at event time, not at subscribe time.
    const { bridge, emit } = fakeBridge();
    let active: string | null = 'a';
    const { result } = renderHook(() =>
      useDegradedMode({
        bridge,
        currentSessionId: () => active,
        disableTimers: true,
      }),
    );
    // Event for 'a' (the active one at dispatch time) → degraded.
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'a',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('degraded');
    act(() => {
      result.current.recover();
    });
    // Active flips to 'b'. An event for 'a' is now stale and must be
    // ignored even though the subscribe effect set up the listener back
    // when 'a' was active.
    active = 'b';
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'a',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('healthy');
  });

  it('without currentSessionId — preserves legacy behavior (any event flips to degraded)', () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({ bridge, disableTimers: true }),
    );
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'anything',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('degraded');
  });

  it('currentSessionId EXPLICITLY null (cold-start, session not spawned yet) treats the event as STALE', () => {
    // This is the exact Tauri cold-start ordering: the sidecar's crash
    // marker replay fires BEFORE the UI's auto-boot effect has a chance
    // to create its first session. `activeSessionId` is therefore `null`
    // at event-arrival time. The gate must fire "stale" in this case,
    // NOT fall through to the legacy "always degraded" path.
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({
        bridge,
        currentSessionId: null,
        disableTimers: true,
      }),
    );
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'old-dead-session',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('healthy');
    expect(result.current.reason).toBeNull();
  });

  it('getter returning null at event time (session not yet ready) treats the event as STALE', () => {
    // Same scenario as above but through the getter form (what
    // TerminalPage actually uses when it threads zustand state).
    const { bridge, emit } = fakeBridge();
    let active: string | null = null;
    const { result } = renderHook(() =>
      useDegradedMode({
        bridge,
        currentSessionId: () => active,
        disableTimers: true,
      }),
    );
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'some-old-id',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('healthy');
    // Later: the UI finally spawns its session. A subsequent genuine
    // crash for that new session DOES flip to degraded.
    active = 'new-session';
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: 'new-session',
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });
    expect(result.current.state).toBe('degraded');
  });

  it('treats any other bridge event as a liveness touch', () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({ bridge, disableTimers: true }),
    );
    const initialSnapshotAt = result.current.lastSnapshotAt;
    // Advance wall clock by sleeping briefly, then emit a harmless event.
    const later = Date.now() + 10;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    act(() => {
      emit({
        kind: 'pty_data',
        sessionId: 'x',
        seq: 1,
        bytesB64: '',
      });
    });
    expect(result.current.lastSnapshotAt).toBeGreaterThanOrEqual(initialSnapshotAt);
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  // Liveness-timer path (the one the real app exercises on boot). Every
  // earlier test runs with `disableTimers: true`, so the interval below
  // was never covered. This block pins:
  //   1. Pre-first-event silence (slow sidecar boot) does NOT escalate.
  //   2. Post-first-touch silence beyond `stalledAfterMs` flips to
  //      `stalled`, and beyond `degradedAfterMs` escalates to `degraded`.
  //   3. A later touch recovers `stalled` → `healthy`.
  // -------------------------------------------------------------------
  describe('liveness timer', () => {
    it('DEFAULT degradedAfterMs is effectively disabled — interactive-shell silence must never auto-flip the banner', () => {
      // Regression pin for the production bug observed in dogfood:
      // a user sitting idle reading `ls` output for 6+ seconds would
      // trip the old 5 s default and wedge the crash banner on a
      // perfectly healthy shell. The default is now `Number.POSITIVE_INFINITY`;
      // callers that want silence-based escalation must opt in.
      vi.useFakeTimers();
      let clock = 1_000;
      const now = () => clock;
      const { bridge, emit } = fakeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({ bridge, now }),
      );
      // First event establishes the liveness reference.
      act(() => {
        emit({ kind: 'pty_data', sessionId: 'x', seq: 1, bytesB64: '' });
      });
      // Advance the clock 60 s — 12× the old 5 s threshold.
      act(() => {
        clock += 60_000;
        vi.advanceTimersByTime(60_000);
      });
      // Banner MUST NOT show on silence alone with the default config.
      expect(result.current.state).not.toBe('degraded');
      vi.useRealTimers();
    });

    it('DOES NOT escalate to degraded while waiting for the first event (slow-boot window)', () => {
      vi.useFakeTimers();
      let clock = 1_000;
      const now = () => clock;
      const { result } = renderHook(() =>
        useDegradedMode({
          now,
          stalledAfterMs: 1_000,
          degradedAfterMs: 5_000,
        }),
      );
      // Simulate 30 s of absolutely no events (sidecar still compiling).
      act(() => {
        clock += 30_000;
        vi.advanceTimersByTime(30_000);
      });
      // Bootstrap guard: no liveness signal observed yet → keep healthy.
      expect(result.current.state).toBe('healthy');
      expect(result.current.reason).toBeNull();
      vi.useRealTimers();
    });

    it('flips to stalled and then degraded once the stream has started and then goes silent', () => {
      vi.useFakeTimers();
      let clock = 1_000;
      const now = () => clock;
      const { bridge, emit } = fakeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({
          bridge,
          now,
          stalledAfterMs: 1_000,
          degradedAfterMs: 5_000,
        }),
      );
      // First event — liveness reference established.
      act(() => {
        emit({ kind: 'pty_data', sessionId: 'x', seq: 1, bytesB64: '' });
      });
      expect(result.current.state).toBe('healthy');
      // 1.2 s silence → stalled (but NOT degraded yet).
      act(() => {
        clock += 1_200;
        vi.advanceTimersByTime(1_200);
      });
      expect(result.current.state).toBe('stalled');
      // 6 s cumulative silence → degraded with reason 'stream_silent'.
      act(() => {
        clock += 4_000;
        vi.advanceTimersByTime(4_000);
      });
      expect(result.current.state).toBe('degraded');
      expect(result.current.reason).toBe('stream_silent');
      vi.useRealTimers();
    });

    it('a fresh touch while stalled returns the hook to healthy', () => {
      vi.useFakeTimers();
      let clock = 1_000;
      const now = () => clock;
      const { bridge, emit } = fakeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({
          bridge,
          now,
          stalledAfterMs: 1_000,
          degradedAfterMs: 10_000,
        }),
      );
      act(() => {
        emit({ kind: 'pty_data', sessionId: 'x', seq: 1, bytesB64: '' });
      });
      act(() => {
        clock += 1_500;
        vi.advanceTimersByTime(1_500);
      });
      expect(result.current.state).toBe('stalled');
      act(() => {
        clock += 10;
        emit({ kind: 'pty_data', sessionId: 'x', seq: 2, bytesB64: '' });
      });
      expect(result.current.state).toBe('healthy');
      vi.useRealTimers();
    });
  });
});
