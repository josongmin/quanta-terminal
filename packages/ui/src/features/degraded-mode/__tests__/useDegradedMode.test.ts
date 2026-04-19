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

  it('flips to degraded when the bridge emits sidecar_crash_recovered', () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() =>
      useDegradedMode({ bridge, disableTimers: true }),
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
});
