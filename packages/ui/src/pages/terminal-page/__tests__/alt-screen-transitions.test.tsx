/**
 * TerminalPage — alt-screen transitions (EPIC-H E2E-H1..H5).
 *
 * Runtime-level integration of the alt-screen story:
 *   1. Enter → data-alt-screen-active flips true within a render.
 *   2. Exit → flips back to false.
 *   3. Nested enter bumps data-alt-screen-depth without re-animating.
 *   4. Crash reports surface on the status bar as `exited with signal`.
 *   5. The transitioning flag clears within ~200 ms (fake timers).
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
vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: () => null,
}));
vi.mock('../../../widgets/history-search/index.js', () => ({
  HistorySearch: () => null,
}));

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
  vi.useRealTimers();
});

// Render the page, then await a pair of microtasks inside act() so the
// async boot effects (idb hydrate + spawn) land their state updates while
// React is still tracking them.
async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TerminalPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('alt-screen transitions on TerminalPage', () => {
  it('E2E-H1: enter flips data-alt-screen-active within a render', async () => {
    seedActiveSession();
    await renderPage();
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('false');
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('true');
  });

  it('E2E-H2: exit reverts data-alt-screen-active to false', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    act(() => {
      useTuiStore.getState().exit();
    });
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('false');
  });

  it('E2E-H3: nested enter bumps depth without flipping active off', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'tmux' });
    });
    expect(screen.getByRole('main').dataset['altScreenDepth']).toBe('1');
    act(() => {
      useTuiStore.getState().enter({ command: 'vim in tmux' });
    });
    expect(screen.getByRole('main').dataset['altScreenDepth']).toBe('2');
    expect(screen.getByRole('main').dataset['altScreenActive']).toBe('true');
  });

  it('E2E-H4: alt-screen crash shows "exited with signal" on the status bar', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
      useTuiStore.getState().reportCrash('signal 9');
    });
    const bar = screen.getByTestId('alt-screen-status-bar');
    expect(bar.dataset['crashed']).toBe('true');
    expect(bar.textContent).toMatch(/exited with signal/);
  });

  it('E2E-H5: the transitioning flag clears within ~200 ms', async () => {
    vi.useFakeTimers();
    seedActiveSession();
    // With fake timers installed the microtask flush in `renderPage` is
    // still driven by the real microtask queue, so it's safe to reuse.
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    expect(useTuiStore.getState().transitioning).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(useTuiStore.getState().transitioning).toBe(false);
  });

  // Alt-screen announcer (a11y live region).

  it('announces "Entered TUI mode" with the command label on enter', async () => {
    seedActiveSession();
    await renderPage();
    // Initial render: the announcer is empty (no transition yet).
    expect(screen.getByTestId('alt-screen-announce').textContent).toBe('');
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    const text = screen.getByTestId('alt-screen-announce').textContent ?? '';
    expect(text.toLowerCase()).toContain('entered');
    expect(text).toContain('vim');
  });

  it('announces "Exited TUI mode, back to shell" on exit', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      useTuiStore.getState().enter({ command: 'vim' });
    });
    act(() => {
      useTuiStore.getState().exit();
    });
    const text = screen.getByTestId('alt-screen-announce').textContent ?? '';
    expect(text.toLowerCase()).toContain('exited');
    expect(text.toLowerCase()).toContain('back to shell');
  });

  it('announcer element is a polite live region with role=status', async () => {
    seedActiveSession();
    await renderPage();
    const node = screen.getByTestId('alt-screen-announce');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.getAttribute('aria-live')).toBe('polite');
    expect(node.getAttribute('aria-atomic')).toBe('true');
  });
});
