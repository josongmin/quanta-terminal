/**
 * TerminalPage view-state transition tests.
 *
 * The page switches between `<EmptyState />`, `<LoadingState />`, `<ErrorState />`
 * and a BlockList / xterm overlay based on the session-store `id` + `health`
 * pair and the alt-screen / TUI detectors. These tests drive the stores
 * directly — they do not mount a real bridge.
 *
 * Phase-4 drift recovery
 * ----------------------
 * Phase 4 wired `TerminalPage` to do a LOT more on mount:
 *   - Hydrate + install block persistence (IndexedDB).
 *   - Auto-spawn the first session via `features/session-tabs/createSession`.
 *   - Install banner/tui detectors and bind the block-entity port.
 *   - Boot with a StrictMode-safe guard so effects don't double-spawn.
 *
 * Phase-3 tests predated all of that and mounted the page expecting a mostly
 * passive chrome. They were `describe.skip`ed during Phase 4 rather than
 * rewritten. This file un-skips them against the current surface by:
 *   1. Mocking the multi-session lifecycle (`features/session-tabs`) so the
 *      mount does not fire a real PTY spawn.
 *   2. Mocking the block-persistence install / hydrate so jsdom does not
 *      touch `indexedDB`.
 *   3. Mocking feature install hooks that subscribe to entity stores to
 *      prevent them accreting listeners across renders.
 *   4. Mocking the `TerminalShell` widget so xterm never boots, and the
 *      command palette + history search surfaces so unrelated effects stay
 *      out of the way.
 *
 * What we assert
 * --------------
 *   - Loading view renders pre-boot (`id: null, health: 'booting'`).
 *   - Error view renders when `health === 'error'` AND no id yet; retry
 *     resets the store.
 *   - Active session renders the BlockList host.
 *   - Escape dismisses the top banner when no other surface is open.
 *   - TUI-active flips the `<main>` `data-tui-active` attribute and mounts
 *     the alt-screen overlay (which contains our TerminalShell stub + a
 *     visual "TUI" badge).
 *   - The shell handle's `focus()` is called when TUI becomes active.
 *   - Exiting TUI reverts to the BlockList surface.
 */

import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted test state: `vi.mock` factories run before imports, so any state
// the mocks close over must be created here too.
const { focusCalls, createSessionSpy } = vi.hoisted(() => ({
  focusCalls: [] as string[],
  createSessionSpy: vi.fn(),
}));

// Stub the xterm-backed TerminalShell and Command surfaces so unrelated
// effects don't fire.
vi.mock('../../../widgets/terminal-shell/index.js', async () => {
  const React = await import('react');
  return {
    TerminalShell: React.forwardRef<{ focus(): void; blur(): void }, unknown>(
      function TerminalShellStub(_props, ref) {
        React.useImperativeHandle(ref, () => ({
          focus: () => {
            focusCalls.push('focus');
          },
          blur: () => {
            focusCalls.push('blur');
          },
        }));
        return <div data-testid="terminal-shell-stub">shell</div>;
      },
    ),
    feedAltScreenStream: vi.fn(),
    useNeedsAltScreen: () => false,
  };
});
vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));
vi.mock('../../../widgets/history-search/index.js', () => ({
  HistorySearch: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="history-search" /> : null,
}));
// Session-tabs triggers a real bridge spawn on mount. Stub every public entry
// point so the boot effect resolves as a no-op. A test that wants to seed a
// session calls `useSessionsStore.getState().addSession({ id, ... })` directly.
vi.mock('../../../features/session-tabs/index.js', () => ({
  createSession: (...args: unknown[]) => createSessionSpy(...args),
  closeSession: vi.fn(async () => {}),
  switchSession: vi.fn(),
  getSessionConnection: vi.fn(() => undefined),
}));
// IDB block persistence: jsdom has no reliable indexedDB — we dodge the whole
// install + hydrate path and return passive stubs. The Phase-4 behavior under
// test here is the view-state graph, not the persistence wiring (that has its
// own test suite under entities/block/__tests__).
vi.mock('../../../entities/block/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../entities/block/index.js')
  >('../../../entities/block/index.js');
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
// Banner/TUI detectors install global subscriptions. In tests we just need
// no-ops with an `unsubscribe` shape so the cleanup code runs.
vi.mock('../../../features/banner/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/banner/index.js')
  >('../../../features/banner/index.js');
  return {
    ...actual,
    installBannerDetectors: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../../features/tui/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/tui/index.js')
  >('../../../features/tui/index.js');
  return {
    ...actual,
    installTuiDetector: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../../features/command/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/command/index.js')
  >('../../../features/command/index.js');
  return {
    ...actual,
    bindBlockEntity: () => () => {},
  };
});
// Phase-4 auto-spawn reads the host bridge on mount. Route `getHostBridge`
// through to a dummy so the accessor never throws.
vi.mock('../../../shared/api/host-bridge.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../shared/api/host-bridge.js')
  >('../../../shared/api/host-bridge.js');
  const dummy = {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
    },
    async ready() {},
    async spawn() {
      return { sessionId: 'mock-sess', shell: '/bin/sh', cwd: '/tmp' };
    },
    async write() {},
    async resize() {},
    async close() {},
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
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe: () => ({ unsubscribe: () => {} }),
  };
  return {
    ...actual,
    getHostBridge: () => dummy,
    tryGetHostBridge: () => dummy,
  };
});

import { TerminalPage } from '../TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../../entities/session/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';
import { useTuiStore } from '../../../entities/tui/index.js';

// A deterministic seed that makes the page render its "have a session" surface
// without actually spawning anything. The `setSession({ id })` path routes
// through the mirror into the collection store (see `entities/session/model`).
function seedActiveSession(): void {
  useSessionStore.getState().setSession({
    id: 'sess-1',
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
}

describe('<TerminalPage />', () => {
  beforeEach(() => {
    createSessionSpy.mockReset();
    createSessionSpy.mockImplementation(async () => {
      // A real createSession would seed the session collection. Most tests
      // don't care about the resulting id because they seed explicitly.
      return { sessionId: 'mock-sess', connection: {} };
    });
    useSessionStore.getState().reset();
    useSessionsStore.getState().reset();
    useBannerStore.getState().resetAll();
    useTuiStore.getState().reset();
    focusCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it('calls createSession on mount (Phase-4 auto-boot)', () => {
    render(<TerminalPage />);
    // StrictMode double-invoke is defended by `bootGuardRef`; we assert the
    // spawn happened at least once. The test runner does not wrap in
    // StrictMode by default, so exactly once is the expected observation.
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('renders <LoadingState /> while booting with no session id', () => {
    render(<TerminalPage />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('renders <ErrorState /> with retry when health=error and no session id', () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    render(<TerminalPage />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /failed to start/iu.test(a.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('button', { name: /try again/iu })).toBeInTheDocument();
  });

  it('ErrorState retry resets the session to booting', () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    // jsdom does not implement navigation; neuter the reload so the retry
    // click completes without throwing. The test only asserts the store
    // reset happened — `window.location.reload` is a side effect downstream.
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload: vi.fn() },
      configurable: true,
      writable: true,
    });
    try {
      render(<TerminalPage />);
      const retry = screen.getByRole('button', { name: /try again/iu });
      act(() => {
        fireEvent.click(retry);
      });
      expect(useSessionStore.getState().health).toBe('booting');
      expect(useSessionStore.getState().id).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    }
  });

  it('renders the BlockList host when a session id is present', () => {
    seedActiveSession();
    render(<TerminalPage />);
    // The page wraps BlockList in a styled host div. Either the stubbed
    // xterm shell is absent (no TUI) or the BlockList scrolls — we assert
    // the main landmark has data-tui-active=false to confirm the
    // "non-TUI" branch rendered.
    const main = screen.getByRole('main');
    expect(main.dataset['tuiActive']).toBe('false');
    // xterm stub is NOT mounted when TUI is inactive.
    expect(screen.queryByTestId('terminal-shell-stub')).toBeNull();
  });

  it('Escape dismisses the top banner when no other surface is open', () => {
    act(() => {
      useBannerStore.getState().raise('shell_integration');
    });
    render(<TerminalPage />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    const bs = useBannerStore.getState();
    expect(bs.dismissed.has('shell_integration')).toBe(true);
  });

  describe('Phase 3: TUI alt-screen swap', () => {
    it('flips data-tui-active and mounts the alt-screen overlay when TUI active', () => {
      seedActiveSession();
      render(<TerminalPage />);
      const mainBefore = screen.getByRole('main');
      expect(mainBefore.dataset['tuiActive']).toBe('false');
      expect(screen.queryByText('TUI')).toBeNull();

      act(() => {
        useTuiStore.getState().enter();
      });
      const mainAfter = screen.getByRole('main');
      expect(mainAfter.dataset['tuiActive']).toBe('true');
      expect(screen.getByTestId('terminal-shell-stub')).toBeInTheDocument();
      // A "TUI" badge is rendered in the overlay label.
      expect(screen.getByText('TUI')).toBeInTheDocument();
    });

    it('calls shell.focus() when TUI becomes active', async () => {
      seedActiveSession();
      render(<TerminalPage />);
      act(() => {
        useTuiStore.getState().enter();
      });
      // `requestAnimationFrame` is polyfilled to `setTimeout` in jsdom — wait
      // on an observable assertion rather than hardcoding a timer.
      await waitFor(() => {
        expect(focusCalls).toContain('focus');
      });
    });

    it('reverts to BlockList when TUI exits', () => {
      seedActiveSession();
      render(<TerminalPage />);
      act(() => {
        useTuiStore.getState().enter();
      });
      expect(screen.getByRole('main').dataset['tuiActive']).toBe('true');
      act(() => {
        useTuiStore.getState().exit();
      });
      expect(screen.getByRole('main').dataset['tuiActive']).toBe('false');
      expect(screen.queryByText('TUI')).toBeNull();
    });
  });
});
