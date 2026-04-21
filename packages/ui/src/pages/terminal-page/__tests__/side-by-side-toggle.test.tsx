/**
 * TerminalPage — side-by-side dev flag toggle (EPIC-H §4.3).
 *
 *   1. Default: flag off → the harness is NOT mounted.
 *   2. Flipping `localStorage['quanta.experimental.side-by-side']` = 'true'
 *      and firing a storage event causes the harness to mount.
 *   3. Flipping back to 'false' unmounts the harness.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createSessionSpy } = vi.hoisted(() => ({ createSessionSpy: vi.fn() }));

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
  return { ...actual, installBannerDetectors: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../../features/tui/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../features/tui/index.js')>(
    '../../../features/tui/index.js',
  );
  return { ...actual, installTuiDetector: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../../features/command/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../features/command/index.js')>(
    '../../../features/command/index.js',
  );
  return { ...actual, bindBlockEntity: () => () => {} };
});
vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: () => null,
}));
vi.mock('../../../widgets/history-search/index.js', () => ({
  HistorySearch: () => null,
}));
vi.mock('../../../widgets/terminal-shell/index.js', async () => {
  const React = await import('react');
  return {
    TerminalShell: React.forwardRef<{ focus(): void; blur(): void }, unknown>(
      function TerminalShellStub(_props, ref) {
        React.useImperativeHandle(ref, () => ({ focus: () => {}, blur: () => {} }));
        return <div data-testid="terminal-shell-stub" />;
      },
    ),
    feedAltScreenStream: vi.fn(),
    useNeedsAltScreen: () => false,
    subscribeNeedsAltScreen: vi.fn(() => () => {}),
    getNeedsAltScreen: vi.fn(() => false),
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
    ready: async () => {},
    spawn: async () => ({ sessionId: 'mock-sess', shell: '/bin/sh', cwd: '/tmp' }),
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
      id: 'stub',
      command: 'ls',
      tier: 'safe' as const,
      modifiers: [],
      rulesetVersion: 1,
    }),
    subscribe: () => ({ unsubscribe: () => {} }),
  };
  return { ...actual, getHostBridge: () => dummy, tryGetHostBridge: () => dummy };
});

import { TerminalPage } from '../TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../../entities/session/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';
import { useTuiStore } from '../../../entities/tui/index.js';

/**
 * jsdom's localStorage implementation is present but some harnesses stub
 * window with a fixture that lacks Storage prototype methods. Guarantee
 * a working polyfill before the tests run.
 */
function ensureLocalStorage(): Storage {
  if (typeof window === 'undefined') {
    throw new Error('window unavailable');
  }
  if (
    !window.localStorage ||
    typeof window.localStorage.setItem !== 'function'
  ) {
    const backing = new Map<string, string>();
    const stub: Storage = {
      get length() {
        return backing.size;
      },
      clear() {
        backing.clear();
      },
      getItem(key) {
        return backing.get(key) ?? null;
      },
      key(index) {
        return Array.from(backing.keys())[index] ?? null;
      },
      removeItem(key) {
        backing.delete(key);
      },
      setItem(key, value) {
        backing.set(key, String(value));
      },
    };
    Object.defineProperty(window, 'localStorage', {
      value: stub,
      configurable: true,
      writable: true,
    });
  }
  return window.localStorage;
}

function seedActiveSession(): void {
  useSessionStore.getState().setSession({
    id: 'sess-1',
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
}

beforeEach(() => {
  createSessionSpy.mockReset();
  createSessionSpy.mockImplementation(async () => ({ sessionId: 'mock-sess', connection: {} }));
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useTuiStore.getState().reset();
  ensureLocalStorage().removeItem('quanta.experimental.side-by-side');
});

afterEach(async () => {
  // Unmount inside `act` so TerminalPage's post-unmount effects
  // (session teardown, banner detector dispose, etc.) don't fire outside
  // React's scope.
  await act(async () => {
    cleanup();
    await Promise.resolve();
  });
  ensureLocalStorage().removeItem('quanta.experimental.side-by-side');
});

/**
 * Mount `TerminalPage` inside `act` and flush the mount-phase effects
 * (auto-boot `createSession`, banner detectors, session tabs). Two
 * microtask ticks cover the chained promise-then + passive effect
 * commit that the production boot path schedules.
 */
async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TerminalPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('side-by-side dev flag', () => {
  it('default — harness is NOT mounted', async () => {
    seedActiveSession();
    await renderPage();
    expect(screen.queryByTestId('side-by-side-harness')).toBeNull();
  });

  it('mounts when the localStorage flag flips to true', async () => {
    seedActiveSession();
    ensureLocalStorage().setItem('quanta.experimental.side-by-side', 'true');
    await renderPage();
    expect(screen.getByTestId('side-by-side-harness')).toBeInTheDocument();
  });

  it('unmounts when the flag flips back to false via storage event', async () => {
    seedActiveSession();
    ensureLocalStorage().setItem('quanta.experimental.side-by-side', 'true');
    await renderPage();
    expect(screen.getByTestId('side-by-side-harness')).toBeInTheDocument();
    await act(async () => {
      ensureLocalStorage().setItem('quanta.experimental.side-by-side', 'false');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'quanta.experimental.side-by-side',
          newValue: 'false',
        }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByTestId('side-by-side-harness')).toBeNull();
  });
});
