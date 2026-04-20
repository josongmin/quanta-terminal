/**
 * **Final E2E — degraded mode**
 *
 * Simulates an engine death and verifies the user-visible surface:
 *
 *   bridge emits `pty_exit { signal: 'sidecar_crash_recovered' }` →
 *   `useDegradedMode` flips to `degraded` →
 *   `DegradedBanner` renders →
 *   the last `GridSnapshot` remains readable on the mirror (RFC §20:
 *   the mirror is never wiped on engine death) →
 *   subsequent writes through the production seams drop silently and
 *   increment `droppedInputs` (RFC §20 "input disabled").
 *
 * Input-drop is now covered end-to-end. The gate lives in
 * `features/degraded-mode/degraded-gate.ts`; both production write sites
 * (`features/command/execute.ts` → `submitCommand`, and
 * `features/session/connect.ts` → `ConnectedSession.write`) consult it
 * before touching `bridge.write`. The tests below wire the gate against a
 * real `useDegradedMode` handle and a spy bridge — no fake typeInto, no
 * parallel gating logic.
 *
 * Retires RFC §22 #17 (engine crash → black screen) at the UI boundary.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
} from '@quanta/host-common';

import { DegradedBanner } from '../../features/degraded-mode/DegradedBanner.js';
import { useDegradedMode } from '../../features/degraded-mode/useDegradedMode.js';
import {
  bindDegradedGate,
  __resetDegradedGateForTests,
} from '../../features/degraded-mode/degraded-gate.js';
import {
  submitCommand,
  type SubmitCommandResult,
} from '../../features/command/execute.js';
import {
  bindBlockStore,
  type BlockStoreActions,
} from '../../features/command/block-store-port.js';
import { connectSession } from '../../features/session/connect.js';
import { useSessionStore } from '../../entities/session/index.js';
import type { BlockId } from '../../shared/types/generated/index.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';

const SESSION_ID = '01J00000000000000000000001';

interface TestBridge {
  readonly bridge: HostBridge;
  readonly emit: (event: HostEvent) => void;
  readonly listenerCount: () => number;
  readonly writeSpy: ReturnType<typeof vi.fn>;
}

function makeBridge(): TestBridge {
  const listeners = new Set<HostEventListener>();
  const writeSpy = vi.fn().mockResolvedValue(undefined);
  const bridge: HostBridge = {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
    },
    ready: async () => {},
    spawn: async () => ({ sessionId: 'x', shell: '/bin/sh', cwd: '/' }),
    write: writeSpy,
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
  };
  return {
    bridge,
    emit: (event: HostEvent) => {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
    writeSpy,
  };
}

function mirrorWithContent(): GridMirror {
  const mirror = new GridMirror({});
  mirror.applySnapshot({
    session_id: SESSION_ID,
    grid_epoch: 1,
    sequence_no: 0,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: {
      kind: 'grid_snapshot',
      rows: 2,
      cols: 8,
      buffer_kind: 'main',
      row_deltas: [
        {
          row: 0,
          revision_before: 0,
          revision_after: 1,
          spans: [
            {
              cols: 5,
              sgr: '0x0000000000000000',
              graphemes: { utf8: 'hello' },
              hyperlink_id: 0,
              ext: null,
            },
            {
              cols: 3,
              sgr: '0x0000000000000000',
              graphemes: 'blank',
              hyperlink_id: 0,
              ext: null,
            },
          ],
          continuation: false,
          hyperlink_refs: [],
        },
      ],
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block',
        blinking: false,
        pending_wrap: false,
      },
      mode_state: {},
      meta: {},
    },
  });
  return mirror;
}

/**
 * Full surface: subscribes to the bridge through `useDegradedMode` and
 * renders the banner + a read-only row probe exactly the way `TerminalPage`
 * does.
 */
function DegradedHarness(props: {
  readonly bridge: HostBridge;
  readonly mirror: GridMirror;
  readonly onRestart: () => void;
}): JSX.Element {
  const status = useDegradedMode({
    bridge: props.bridge,
    disableTimers: true,
  });
  const row0 = props.mirror.getRow(0);
  const rowText =
    row0?.cells
      .map((c) => c.grapheme)
      .join('')
      .trim() ?? '';
  return (
    <div>
      <div data-testid="state">{status.state}</div>
      <div data-testid="reason">{status.reason ?? ''}</div>
      <div data-testid="frozen-row-0">{rowText}</div>
      {status.state === 'degraded' ? (
        <DegradedBanner reason={status.reason ?? undefined} onRestart={props.onRestart} />
      ) : null}
    </div>
  );
}

function emitCrash(emit: (e: HostEvent) => void): void {
  emit({
    kind: 'pty_exit',
    sessionId: SESSION_ID,
    exitCode: null,
    signal: 'sidecar_crash_recovered',
  });
}

/**
 * Minimal block-store adapter so `submitCommand` exercises the "happy" path
 * (startBlock → bridge.write) when the gate does not fire.
 */
function makeBlockStoreStub(): BlockStoreActions {
  let active: BlockId | null = null;
  let counter = 0;
  return {
    createBlock: () => {
      counter += 1;
      const id = `blk-${counter}` as BlockId;
      return id;
    },
    startBlock: () => {
      counter += 1;
      const id = `blk-${counter}` as BlockId;
      active = id;
      return id;
    },
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    appendBlockOutput: () => {},
    completeBlock: (id) => {
      if (active === id) active = null;
    },
    cancelBlock: (id) => {
      if (active === id) active = null;
    },
    errorBlock: (id) => {
      if (active === id) active = null;
    },
    getRunningBlockIds: () => [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  __resetDegradedGateForTests();
  useSessionStore.getState().reset();
});

describe('degraded mode (e2e)', () => {
  it('banner appears synchronously on sidecar_crash_recovered (well under 500 ms budget)', () => {
    const { bridge, emit } = makeBridge();
    const mirror = mirrorWithContent();
    render(<DegradedHarness bridge={bridge} mirror={mirror} onRestart={() => {}} />);
    expect(screen.getByTestId('state').textContent).toBe('healthy');
    expect(screen.queryByTestId('degraded-banner')).toBeNull();

    act(() => {
      emitCrash(emit);
    });

    expect(screen.getByTestId('state').textContent).toBe('degraded');
    expect(screen.getByTestId('reason').textContent).toBe('engine_crashed');
    const banner = screen.getByTestId('degraded-banner');
    expect(banner).toBeTruthy();
    expect(banner.dataset['reason']).toBe('engine_crashed');
  });

  it('the last GridSnapshot stays readable on the mirror after engine death (RFC §20)', () => {
    const { bridge, emit } = makeBridge();
    const mirror = mirrorWithContent();
    render(<DegradedHarness bridge={bridge} mirror={mirror} onRestart={() => {}} />);
    expect(screen.getByTestId('frozen-row-0').textContent).toBe('hello');
    act(() => {
      emitCrash(emit);
    });
    expect(screen.getByTestId('state').textContent).toBe('degraded');
    expect(screen.getByTestId('frozen-row-0').textContent).toBe('hello');
    // Mirror itself still reports the pre-crash row — nothing in the
    // degraded path touches it.
    expect(
      mirror
        .getRow(0)
        ?.cells.map((c) => c.grapheme)
        .join('')
        .trim(),
    ).toBe('hello');
  });

  it('the banner carries exactly one button (Restart) — no close/dismiss — and clicking it fires onRestart', async () => {
    const { bridge, emit } = makeBridge();
    const onRestart = vi.fn();
    render(
      <DegradedHarness bridge={bridge} mirror={mirrorWithContent()} onRestart={onRestart} />,
    );
    act(() => {
      emitCrash(emit);
    });
    const banner = screen.getByTestId('degraded-banner');
    const buttons = banner.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).dataset['testid']).toBe(
      'degraded-banner-restart',
    );
    // `handleClick` schedules a `queueMicrotask` that toggles `restarting`
    // back off — flush every pending microtask INSIDE act so the follow-up
    // re-render stays in React's scope and no "update not wrapped in act"
    // warning bleeds into the test output. Awaiting two microtasks: one
    // drains the queued setRestarting(false), the next lets React commit.
    await act(async () => {
      fireEvent.click(buttons[0] as HTMLButtonElement);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('a graceful pty_exit (no crash signal) does not promote the UI into degraded state', () => {
    const { bridge, emit } = makeBridge();
    render(
      <DegradedHarness bridge={bridge} mirror={mirrorWithContent()} onRestart={() => {}} />,
    );
    act(() => {
      emit({
        kind: 'pty_exit',
        sessionId: SESSION_ID,
        exitCode: 0,
        signal: null,
      });
    });
    expect(screen.getByTestId('state').textContent).toBe('healthy');
    expect(screen.queryByTestId('degraded-banner')).toBeNull();
  });

  it('a second sidecar_crash_recovered while already degraded is idempotent — banner stays mounted with the same reason', () => {
    const { bridge, emit } = makeBridge();
    render(
      <DegradedHarness bridge={bridge} mirror={mirrorWithContent()} onRestart={() => {}} />,
    );
    act(() => {
      emitCrash(emit);
    });
    const firstReason = screen.getByTestId('degraded-banner').dataset['reason'];
    act(() => {
      emitCrash(emit);
    });
    const secondReason = screen.getByTestId('degraded-banner').dataset['reason'];
    expect(secondReason).toBe(firstReason);
    expect(screen.getByTestId('state').textContent).toBe('degraded');
  });

  it('unmount releases the bridge subscription (no leaked listener)', () => {
    const { bridge, listenerCount } = makeBridge();
    const { unmount } = render(
      <DegradedHarness
        bridge={bridge}
        mirror={mirrorWithContent()}
        onRestart={() => {}}
      />,
    );
    expect(listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(listenerCount()).toBe(0);
  });

  /**
   * Input-drop tests — exercise the **real** production seam:
   *   TerminalPage-equivalent gate binding  → `submitCommand` →
   *   `tryGetDegradedGate()` → write dropped, counter bumped.
   *
   * No fake `typeInto`. The write spy on the bridge is how we know whether
   * bytes would have reached the PTY.
   */
  describe('input drop through the production path (RFC §20)', () => {
    it('healthy: submitCommand writes through to bridge.write', async () => {
      const { bridge, writeSpy } = makeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({ bridge, disableTimers: true }),
      );
      const releaseGate = bindDegradedGate({
        isDegraded: () => result.current.state === 'degraded',
        reportDroppedInput: () => result.current.incrementDroppedInput(),
      });
      const releaseBlocks = bindBlockStore(makeBlockStoreStub());
      useSessionStore.getState().setSession({ id: SESSION_ID, health: 'ready' });

      try {
        expect(result.current.state).toBe('healthy');
        const outcome = await submitCommand({ text: 'ls', bridge });
        expect(outcome.ok).toBe(true);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith(SESSION_ID, 'ls\n');
        expect(result.current.droppedInputs).toBe(0);
      } finally {
        releaseGate();
        releaseBlocks();
      }
    });

    it('degraded: submitCommand drops the write and increments droppedInputs', async () => {
      const { bridge, writeSpy, emit } = makeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({ bridge, disableTimers: true }),
      );
      const releaseGate = bindDegradedGate({
        isDegraded: () => result.current.state === 'degraded',
        reportDroppedInput: () => result.current.incrementDroppedInput(),
      });
      const releaseBlocks = bindBlockStore(makeBlockStoreStub());
      useSessionStore.getState().setSession({ id: SESSION_ID, health: 'ready' });

      try {
        act(() => emitCrash(emit));
        expect(result.current.state).toBe('degraded');

        let outcome: SubmitCommandResult | undefined;
        await act(async () => {
          outcome = await submitCommand({ text: 'ls', bridge });
        });
        expect(outcome).toEqual({ ok: false, reason: 'degraded' });
        expect(writeSpy).not.toHaveBeenCalled();
        expect(result.current.droppedInputs).toBe(1);

        // Second drop counts independently — the counter reflects every
        // keystroke-equivalent event that was denied, not a coarse flag.
        let second: SubmitCommandResult | undefined;
        await act(async () => {
          second = await submitCommand({ text: 'pwd', bridge });
        });
        expect(second).toEqual({ ok: false, reason: 'degraded' });
        expect(writeSpy).not.toHaveBeenCalled();
        expect(result.current.droppedInputs).toBe(2);
      } finally {
        releaseGate();
        releaseBlocks();
      }
    });

    it('recover: after recover() submitCommand writes through again', async () => {
      const { bridge, writeSpy, emit } = makeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({ bridge, disableTimers: true }),
      );
      const releaseGate = bindDegradedGate({
        isDegraded: () => result.current.state === 'degraded',
        reportDroppedInput: () => result.current.incrementDroppedInput(),
      });
      const releaseBlocks = bindBlockStore(makeBlockStoreStub());
      useSessionStore.getState().setSession({ id: SESSION_ID, health: 'ready' });

      try {
        act(() => emitCrash(emit));
        expect(result.current.state).toBe('degraded');
        await act(async () => {
          await submitCommand({ text: 'ls', bridge });
        });
        expect(writeSpy).not.toHaveBeenCalled();
        expect(result.current.droppedInputs).toBe(1);

        act(() => {
          result.current.recover();
        });
        expect(result.current.state).toBe('healthy');

        let outcome: SubmitCommandResult | undefined;
        await act(async () => {
          outcome = await submitCommand({ text: 'pwd', bridge });
        });
        expect(outcome?.ok).toBe(true);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith(SESSION_ID, 'pwd\n');
        // The counter is preserved across recovery — droppedInputs is
        // cumulative, not per-episode (useful for telemetry reporting).
        expect(result.current.droppedInputs).toBe(1);
      } finally {
        releaseGate();
        releaseBlocks();
      }
    });

    it('no gate bound: submitCommand behaves exactly as before (write passes through)', async () => {
      // Explicitly do not call bindDegradedGate — mirrors headless tests and
      // the pre-TerminalPage-mount boot window. No degraded concept → no
      // drops, no telemetry bumps, the bridge sees every write.
      const { bridge, writeSpy } = makeBridge();
      const releaseBlocks = bindBlockStore(makeBlockStoreStub());
      useSessionStore.getState().setSession({ id: SESSION_ID, health: 'ready' });

      try {
        const outcome = await submitCommand({ text: 'ls', bridge });
        expect(outcome.ok).toBe(true);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith(SESSION_ID, 'ls\n');
      } finally {
        releaseBlocks();
      }
    });

    it('ConnectedSession.write consults the gate and drops bytes while degraded (RFC §20 — second production write site)', async () => {
      // The header comment promises BOTH production write seams honor the
      // gate; `submitCommand` is tested above. This test exercises the
      // second seam — `ConnectedSession.write`, called by any caller that
      // holds the session handle directly (future input-host keystrokes).
      const { bridge, writeSpy, emit } = makeBridge();
      const { result } = renderHook(() =>
        useDegradedMode({ bridge, disableTimers: true }),
      );
      const releaseGate = bindDegradedGate({
        isDegraded: () => result.current.state === 'degraded',
        reportDroppedInput: () => result.current.incrementDroppedInput(),
      });

      try {
        const session = await connectSession({
          bridge,
          cols: 80,
          rows: 24,
          onData: () => undefined,
        });
        // Healthy — write lands on bridge. `session.write` itself is side-
        // effect-free on React state, but the test harness's `renderHook`
        // component re-renders when the bridge subscription fires; wrap
        // the async boundaries in act so the React root stays quiet.
        await act(async () => {
          await session.write('healthy\n');
        });
        expect(writeSpy).toHaveBeenCalledTimes(1);
        // spawn() resolves with sessionId='x' in makeBridge(); pin the
        // actual value the wrapper forwarded.
        expect(writeSpy).toHaveBeenCalledWith('x', 'healthy\n');

        // Flip to degraded via the bridge event. connectSession subscribes
        // to the same bridge; the crash is for SESSION_ID (not 'x'), so
        // the degraded hook transitions via the generic pty_exit path.
        act(() => emitCrash(emit));
        expect(result.current.state).toBe('degraded');

        // Degraded — write is dropped, counter bumps, bridge sees nothing new.
        const callCountBefore = writeSpy.mock.calls.length;
        await act(async () => {
          await session.write('dropped\n');
        });
        expect(writeSpy.mock.calls.length).toBe(callCountBefore);
        expect(result.current.droppedInputs).toBe(1);

        await act(async () => {
          await session.close();
        });
      } finally {
        releaseGate();
      }
    });
  });
});
