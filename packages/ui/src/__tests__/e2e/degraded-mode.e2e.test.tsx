/**
 * **Final E2E — degraded mode**
 *
 * Simulates an engine death and verifies the user-visible surface:
 *
 *   bridge emits `pty_exit { signal: 'sidecar_crash_recovered' }` →
 *   `useDegradedMode` flips to `degraded` →
 *   `DegradedBanner` renders →
 *   the last `GridSnapshot` remains readable on the mirror (RFC §20:
 *   the mirror is never wiped on engine death).
 *
 * ### What this file intentionally does NOT test
 *
 * Input-drop during degraded state. `useDegradedMode.incrementDroppedInput`
 * exists on the hook surface, but **no production call site forwards
 * keystrokes through it today** — `input-host` does not consult the
 * degraded hook, and `TerminalPage` only reads the hook to render the
 * banner. A test that wraps its own gating function around the hook would
 * verify the test's own `if (state === 'degraded') return` and nothing in
 * real code. Until the gating lives in `features/input/input-host` (or an
 * analogous production seam), this file holds off on asserting that
 * behavior rather than paint a passing test over a behavioral gap.
 *
 * Retires RFC §22 #17 (engine crash → black screen) at the UI boundary.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
} from '@quanta/host-common';

import { DegradedBanner } from '../../features/degraded-mode/DegradedBanner.js';
import { useDegradedMode } from '../../features/degraded-mode/useDegradedMode.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';

const SESSION_ID = '01J00000000000000000000001';

interface TestBridge {
  readonly bridge: HostBridge;
  readonly emit: (event: HostEvent) => void;
  readonly listenerCount: () => number;
}

function makeBridge(): TestBridge {
  const listeners = new Set<HostEventListener>();
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
  };
  return {
    bridge,
    emit: (event: HostEvent) => {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
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

afterEach(() => {
  vi.useRealTimers();
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
    act(() => {
      fireEvent.click(buttons[0] as HTMLButtonElement);
    });
    // `handleClick` schedules a `queueMicrotask` that toggles `restarting`
    // back off — flush it inside act so the follow-up re-render stays in
    // React's scope.
    await act(async () => {
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
});
