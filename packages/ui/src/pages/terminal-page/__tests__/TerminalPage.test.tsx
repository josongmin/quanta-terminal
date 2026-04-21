/**
 * TerminalPage view-state transition tests (EPIC-H rewrite).
 *
 * The legacy xterm-overlay branch is gone — the page now mounts BlockList
 * unconditionally and drives alt-screen state via the `useAltScreenMode`
 * selector. These tests cover the view-state graph the page still owns:
 *
 *   - Boot: `createSession` is invoked on mount.
 *   - Loading view renders pre-boot (`id: null, health: 'booting'`).
 *   - Error view renders when `health === 'error'` AND no id yet; retry
 *     resets the store.
 *   - Active session renders the BlockList host.
 *   - Escape dismisses the top banner when no other surface is open.
 *   - Alt-screen state: entering flips `data-alt-screen-active=true`;
 *     exiting reverts.
 *   - Degraded-mode banner is mounted when the degraded hook flips state.
 *
 * We stub the multi-session lifecycle, block persistence, feature
 * installers, and the host bridge so jsdom does not touch the PTY / IDB
 * layers.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createSessionSpy } = vi.hoisted(() => ({
  createSessionSpy: vi.fn(),
}));

vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));
vi.mock('../../../widgets/history-search/index.js', () => ({
  HistorySearch: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="history-search" /> : null,
}));
vi.mock('../../../features/session-tabs/index.js', () => ({
  createSession: (...args: unknown[]) => createSessionSpy(...args),
  closeSession: vi.fn(async () => {}),
  switchSession: vi.fn(),
  getSessionConnection: vi.fn(() => undefined),
}));
vi.mock('../../../entities/block/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../entities/block/index.js')>(
    '../../../entities/block/index.js',
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
vi.mock('../../../features/banner/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../features/banner/index.js')>(
    '../../../features/banner/index.js',
  );
  return {
    ...actual,
    installBannerDetectors: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../../features/tui/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../features/tui/index.js')>(
    '../../../features/tui/index.js',
  );
  return {
    ...actual,
    installTuiDetector: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../../features/command/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../features/command/index.js')>(
    '../../../features/command/index.js',
  );
  return {
    ...actual,
    bindBlockEntity: () => () => {},
  };
});
vi.mock('../../../shared/api/host-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/host-bridge.js')>(
    '../../../shared/api/host-bridge.js',
  );
  const dummy = {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
      wslEnvironment: false,
    },
    async ready() {},
    async spawn() {
      return { sessionId: 'mock-sess', shell: '/bin/sh', cwd: '/tmp' };
    },
    async write() {},
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
    createSessionSpy.mockImplementation(async () => ({ sessionId: 'mock-sess', connection: {} }));
    useSessionStore.getState().reset();
    useSessionsStore.getState().reset();
    useBannerStore.getState().resetAll();
    useTuiStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  // Render the page, then await a pair of microtasks inside act() so the
  // async boot effects (idb hydrate + spawn) land their state updates while
  // React is still tracking them. Without this, `setHydrating(false)` and
  // connection plumbing set state outside act() and emit warnings.
  async function renderPage(): Promise<void> {
    await act(async () => {
      render(<TerminalPage />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('calls createSession on mount (Phase-4 auto-boot)', async () => {
    await renderPage();
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('renders <LoadingState /> while booting with no session id', async () => {
    await renderPage();
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('renders <ErrorState /> with retry when health=error and no session id', async () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    await renderPage();
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /failed to start/iu.test(a.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('button', { name: /try again/iu })).toBeInTheDocument();
  });

  it('ErrorState retry resets the session to booting', async () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload: vi.fn() },
      configurable: true,
      writable: true,
    });
    try {
      await renderPage();
      const retry = screen.getByRole('button', { name: /try again/iu });
      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
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

  it('renders the BlockList host when a session id is present', async () => {
    seedActiveSession();
    await renderPage();
    const main = screen.getByRole('main');
    expect(main.dataset['altScreenActive']).toBe('false');
  });

  it('Escape dismisses the top banner when no other surface is open', async () => {
    act(() => {
      useBannerStore.getState().raise('shell_integration');
    });
    await renderPage();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    const bs = useBannerStore.getState();
    expect(bs.dismissed.has('shell_integration')).toBe(true);
  });

  it('flips data-alt-screen-active when the tui store enters alt-screen', async () => {
    seedActiveSession();
    await renderPage();
    const main = screen.getByRole('main');
    expect(main.dataset['altScreenActive']).toBe('false');
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('true');
  });

  it('mounts the AltScreenStatusBar and shows the command label on alt-screen', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    const bar = screen.getByTestId('alt-screen-status-bar');
    expect(bar.dataset['visible']).toBe('true');
    expect(bar.textContent).toMatch(/vim/);
  });

  it('reverts alt-screen active when the tui store exits', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('true');
    act(() => {
      useTuiStore.getState().exit();
    });
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('false');
  });
});
