/**
 * E2E — TUI crash recovery and depth-counter safety
 *
 * Verifies the TUI store's resilience when:
 *
 *   1. PTY crashes while alt-screen is active — `reportCrash` marks the
 *      store and `depth` tracking stays correct.
 *   2. `exit()` after a crash drives `depth` to 0 and clears `active`.
 *   3. `clearCrashed()` releases the ghost frame (sets `crashed: null`).
 *   4. Stray EXIT_1049 with no preceding ENTER_1049 — depth never goes
 *      negative; the store clamps at {active: false, depth: 0}.
 *   5. Multiple stray exits — still clamp at 0; idempotent.
 *   6. Re-entering alt-screen after crash+recovery creates a fresh session
 *      with `depth=1, active=true, crashed=null`.
 *   7. Nested enter (depth=2) + crash + two exits — depth unwinds cleanly.
 *   8. Full page-level integration: pty_exit event during alt-screen →
 *      degraded-mode gate raises → surfaces unmount on the forced EXIT_1049.
 *
 * Tests 1–7 drive `useTuiStore` directly (no React render, no bridge).
 * Test 8 exercises the full TerminalPage pipeline to confirm the UI
 * presents a safe state to the user after a PTY crash.
 *
 * Production gap documented: `useTuiStore.reportCrash()` exists as an API
 * but is not yet called from production code (grep: zero call sites outside
 * this test file and the model definition). When the TerminalPage detects a
 * `pty_exit { signal: 'sidecar_crash_recovered' }` event during alt-screen,
 * it should call both `reportCrash(reason)` and then `exit()` to unwind the
 * depth counter; that wire-up is the planned work tracked in the improvement
 * plan. The store itself (and this test) already encode the expected contract.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

// Store-only tests (no React) import the store directly.
import { useTuiStore } from '../../entities/tui/index.js';

// Page-level imports.
const { createSessionSpy, getSessionConnectionSpy } = vi.hoisted(() => ({
  createSessionSpy: vi.fn(),
  getSessionConnectionSpy: vi.fn(),
}));

vi.mock('../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));
vi.mock('../../widgets/history-search/index.js', () => ({
  HistorySearch: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="history-search" /> : null,
}));
vi.mock('../../features/session-tabs/index.js', () => ({
  createSession: (...args: unknown[]) => createSessionSpy(...args),
  closeSession: vi.fn(async () => {}),
  switchSession: vi.fn(),
  getSessionConnection: (...args: unknown[]) => getSessionConnectionSpy(...args),
}));
vi.mock('../../entities/block/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../entities/block/index.js')>(
    '../../entities/block/index.js',
  );
  return {
    ...actual,
    createIdbBlockAdapter: () => ({
      async hydrate() {
        return [];
      },
      async saveBlock() {},
      async deleteBlock() {},
    }),
    installBlockPersistence: () => ({ uninstall: () => {} }),
    hydrateFromPersistence: vi.fn(async () => {}),
  };
});
vi.mock('../../features/banner/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/banner/index.js')>(
    '../../features/banner/index.js',
  );
  return { ...actual, installBannerDetectors: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../features/notifications/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/notifications/index.js')>(
    '../../features/notifications/index.js',
  );
  return { ...actual, installNotificationDetector: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../features/command/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/command/index.js')>(
    '../../features/command/index.js',
  );
  return { ...actual, bindBlockEntity: () => () => {} };
});

import { TerminalPage } from '../../pages/terminal-page/TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import {
  __emitRawChunkForTests,
  __resetRawObserversForTests,
} from '../../features/command/route-output.js';
import { setHostBridge } from '../../shared/api/host-bridge.js';

const ESC = 0x1b;
const ENTER_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);
const EXIT_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]);
const SESSION_ID = '01J00000000000000000000001' as SessionId;

interface FakeBridge extends HostBridge {
  readonly emit: (event: HostEvent) => void;
  readonly write: ReturnType<typeof vi.fn>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const write = vi.fn().mockResolvedValue(undefined);
  return {
    capabilities: DEFAULT_CAPABILITIES,
    write,
    async ready() {},
    async spawn() {
      return { sessionId: SESSION_ID, shell: '/bin/sh', cwd: '/tmp' };
    },
    async resize() {},
    async close() {},
    async cancelBlock() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async uninstallShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        removedRegion: '',
        alreadyAbsent: true,
        fileMissing: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async notify() {},
    async readTextFile() {
      return null;
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'vim',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    emit: (event: HostEvent) => {
      for (const l of listeners) l(event);
    },
  } satisfies FakeBridge;
}

function seedActiveSession(): void {
  useSessionStore.getState().setSession({
    id: SESSION_ID,
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
  useSessionsStore.getState().addSession({
    id: SESSION_ID,
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
  useSessionsStore.getState().setActive(SESSION_ID);
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TerminalPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = makeBridge();
  setHostBridge(bridge);
  (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__ = 'memory';

  createSessionSpy.mockReset();
  createSessionSpy.mockImplementation(async () => ({
    sessionId: SESSION_ID,
    connection: {
      sessionId: SESSION_ID,
      async write() {},
      async close() {},
      async resize() {},
      async cancelBlock() {},
    },
  }));
  getSessionConnectionSpy.mockReset();
  getSessionConnectionSpy.mockReturnValue(undefined);

  __resetRawObserversForTests();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useTuiStore.getState().reset();
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useBlockStore.getState().resetAll();
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
});

// -------------------------------------------------------------------------
// Store-level tests (1–7): direct state manipulation, no React render.
// -------------------------------------------------------------------------

describe('TUI crash recovery — store behavior (e2e)', () => {
  it('reportCrash sets the crashed field while depth and active are unchanged', () => {
    useTuiStore.getState().enter();
    expect(useTuiStore.getState().active).toBe(true);
    expect(useTuiStore.getState().depth).toBe(1);

    useTuiStore.getState().reportCrash('sidecar_crash_recovered');

    expect(useTuiStore.getState().crashed).toEqual({ reason: 'sidecar_crash_recovered' });
    expect(useTuiStore.getState().active).toBe(true);
    expect(useTuiStore.getState().depth).toBe(1);
  });

  it('exit() after reportCrash drives depth to 0 and active to false', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().reportCrash('sidecar_crash_recovered');
    useTuiStore.getState().exit();

    expect(useTuiStore.getState().active).toBe(false);
    expect(useTuiStore.getState().depth).toBe(0);
    // Crashed state remains until clearCrashed() is called — the ghost frame.
    expect(useTuiStore.getState().crashed).not.toBeNull();
  });

  it('clearCrashed() releases the ghost frame (crashed → null)', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().reportCrash('sidecar_crash_recovered');
    useTuiStore.getState().exit();
    useTuiStore.getState().clearCrashed();

    expect(useTuiStore.getState().crashed).toBeNull();
    expect(useTuiStore.getState().active).toBe(false);
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('stray exit() with depth=0 does not go negative (clamps at 0)', () => {
    expect(useTuiStore.getState().depth).toBe(0);
    useTuiStore.getState().exit();

    expect(useTuiStore.getState().depth).toBe(0);
    expect(useTuiStore.getState().active).toBe(false);
  });

  it('five stray exits in a row never drive depth below 0', () => {
    for (let i = 0; i < 5; i += 1) {
      useTuiStore.getState().exit();
    }
    expect(useTuiStore.getState().depth).toBe(0);
    expect(useTuiStore.getState().active).toBe(false);
  });

  it('re-entering after crash+recovery resets depth to 1 and cleared crashed', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().reportCrash('sidecar_crash_recovered');
    useTuiStore.getState().exit();
    useTuiStore.getState().clearCrashed();

    useTuiStore.getState().enter({ command: 'vim' });

    expect(useTuiStore.getState().active).toBe(true);
    expect(useTuiStore.getState().depth).toBe(1);
    expect(useTuiStore.getState().crashed).toBeNull();
    expect(useTuiStore.getState().command).toBe('vim');
  });

  it('nested enter (depth=2) + crash + two exits unwinds to depth=0', () => {
    useTuiStore.getState().enter({ command: 'tmux' });
    useTuiStore.getState().enter({ command: 'vim in tmux' });
    expect(useTuiStore.getState().depth).toBe(2);

    useTuiStore.getState().reportCrash('sidecar_crash_recovered');

    // First exit peels one level; still active at depth=1.
    useTuiStore.getState().exit();
    expect(useTuiStore.getState().depth).toBe(1);
    expect(useTuiStore.getState().active).toBe(true);

    // Second exit brings depth to 0 and flips active off.
    useTuiStore.getState().exit();
    expect(useTuiStore.getState().depth).toBe(0);
    expect(useTuiStore.getState().active).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Page-level integration test (scenario 8).
// -------------------------------------------------------------------------

describe('TUI crash recovery — full page integration (e2e)', () => {
  it('pty_exit during alt-screen: surfaces unmount when EXIT_1049 follows the crash signal', async () => {
    seedActiveSession();
    await renderPage();

    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(screen.getByTestId('tui-input-surface')).toBeInTheDocument();

    // Simulate a PTY sidecar crash: bridge emits pty_exit with the crash signal
    // while the alt-screen is still open. The degraded-mode hook fires.
    act(() => {
      bridge.emit({
        kind: 'pty_exit',
        sessionId: SESSION_ID,
        exitCode: null,
        signal: 'sidecar_crash_recovered',
      });
    });

    // The alt-screen is still technically active (the TUI detector has not
    // yet seen EXIT_1049 — the crash killed the process before it could emit
    // the cleanup sequence). The surfaces remain mounted during the ghost
    // frame window. The store's `active` is still true.
    expect(useTuiStore.getState().active).toBe(true);
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();

    // The sidecar restarts and the reconnected stream eventually sends the
    // deferred EXIT_1049 (or the TerminalPage forces it on reconnect).
    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });

    expect(useTuiStore.getState().active).toBe(false);
    expect(useTuiStore.getState().depth).toBe(0);
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
  });
});
