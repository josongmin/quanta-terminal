/**
 * Split-pane keybinding tests. Covers the TerminalPage wiring for:
 *   - Cmd+D  → horizontal split (spawn + graft)
 *   - Cmd+Shift+D → vertical split
 *   - Cmd+\  → cycle pane focus
 *
 * We reuse the heavy mock harness from `TerminalPage.test.tsx` so the page
 * mounts without spawning a real bridge. Session creation for both the
 * first boot and the `splitActivePane` call is serviced by the same
 * `createSession` mock.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));
vi.mock('../../../widgets/history-search/index.js', () => ({
  HistorySearch: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="history-search" /> : null,
}));

const { createSessionSpy } = vi.hoisted(() => ({
  createSessionSpy: vi.fn(),
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

// Swap out the pane-tabs actions for a spy module so we can assert the
// keymap plumbing without exercising the real session-tabs lifecycle (which
// would require a real bridge).
const paneTabsSpies = vi.hoisted(() => ({
  splitActivePaneSpy: vi.fn((_opts: unknown) => Promise.resolve('new-sess')),
  focusPaneSiblingSpy: vi.fn((_delta: number) => {}),
  closeActivePaneSpy: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../../features/pane-tabs/index.js', () => ({
  splitActivePane: (opts: unknown) => paneTabsSpies.splitActivePaneSpy(opts),
  focusPaneSibling: (delta: number) => paneTabsSpies.focusPaneSiblingSpy(delta),
  closeActivePane: () => paneTabsSpies.closeActivePaneSpy(),
}));

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
import { usePaneStore } from '../../../entities/pane/index.js';
import { useSessionStore, useSessionsStore } from '../../../entities/session/index.js';
import { useTuiStore } from '../../../entities/tui/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';
import { __resetKeymapForTests } from '../../../shared/lib/keymap.js';

function triggerKey(
  key: string,
  opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
}

function pinMacPlatform(): () => void {
  const prev = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  });
  return () => {
    if (prev) Object.defineProperty(navigator, 'platform', prev);
  };
}

describe('TerminalPage split-pane keybindings', () => {
  let unpin: () => void;

  beforeEach(() => {
    unpin = pinMacPlatform();
    __resetKeymapForTests();
    usePaneStore.getState().reset();
    useSessionStore.getState().reset();
    useSessionsStore.getState().reset();
    useTuiStore.getState().reset();
    useBannerStore.getState().resetAll();
    createSessionSpy.mockReset();
    createSessionSpy.mockImplementation(async () => ({
      sessionId: 'mock-sess',
      connection: {},
    }));
    paneTabsSpies.splitActivePaneSpy.mockClear();
    paneTabsSpies.focusPaneSiblingSpy.mockClear();
    paneTabsSpies.closeActivePaneSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    unpin();
    __resetKeymapForTests();
    usePaneStore.getState().reset();
  });

  async function renderPage(): Promise<void> {
    await act(async () => {
      render(<TerminalPage />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('Cmd+D triggers a horizontal split', async () => {
    await renderPage();
    act(() => {
      triggerKey('d', { meta: true });
    });
    expect(paneTabsSpies.splitActivePaneSpy).toHaveBeenCalledTimes(1);
    const firstCall = paneTabsSpies.splitActivePaneSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const opts = firstCall?.[0] as unknown as { readonly dir: 'horizontal' | 'vertical' };
    expect(opts.dir).toBe('horizontal');
  });

  it('Cmd+Shift+D triggers a vertical split', async () => {
    await renderPage();
    act(() => {
      triggerKey('d', { meta: true, shift: true });
    });
    expect(paneTabsSpies.splitActivePaneSpy).toHaveBeenCalledTimes(1);
    const firstCall = paneTabsSpies.splitActivePaneSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const opts = firstCall?.[0] as unknown as { readonly dir: 'horizontal' | 'vertical' };
    expect(opts.dir).toBe('vertical');
  });

  it('Cmd+\\ cycles pane focus forward', async () => {
    await renderPage();
    act(() => {
      triggerKey('\\', { meta: true });
    });
    expect(paneTabsSpies.focusPaneSiblingSpy).toHaveBeenCalledTimes(1);
    const firstCall = paneTabsSpies.focusPaneSiblingSpy.mock.calls[0];
    expect(firstCall?.[0]).toBe(1);
  });

  it('Cmd+W closes the focused pane when the tree is a split', async () => {
    await renderPage();
    // Seed a multi-pane tree so Cmd+W routes through closeActivePane.
    act(() => {
      const s = usePaneStore.getState();
      s.setRoot('a' as never);
      s.splitActive('horizontal', 'b' as never);
    });
    act(() => {
      triggerKey('w', { meta: true });
    });
    expect(paneTabsSpies.closeActivePaneSpy).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+Enter toggles pane zoom and updates the live region', async () => {
    await renderPage();
    // Seed two panes so the zoom toggle actually has something to maximize.
    // TerminalPage's guard short-circuits when the tree is a single leaf.
    act(() => {
      const s = usePaneStore.getState();
      s.setRoot('a' as never);
      s.splitActive('horizontal', 'b' as never);
    });

    expect(usePaneStore.getState().zoomedPaneId).toBeNull();

    act(() => {
      triggerKey('Enter', { meta: true, shift: true });
    });
    // Focus was on the newly-split right pane (b) after setRoot+splitActive.
    expect(usePaneStore.getState().zoomedPaneId).toBe('b');

    // Aria-live announcement appears in the pane-zoom region.
    const announce = document.querySelector('[data-testid="pane-zoom-announce"]');
    expect(announce?.textContent).toMatch(/zoomed/i);

    // Second press restores.
    act(() => {
      triggerKey('Enter', { meta: true, shift: true });
    });
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
    expect(announce?.textContent).toMatch(/restored/i);
  });

  it('pane-zoom live region uses aria-live="assertive" (WCAG mode-change requirement)', async () => {
    await renderPage();
    const announce = document.querySelector('[data-testid="pane-zoom-announce"]');
    expect(announce).not.toBeNull();
    expect(announce?.getAttribute('aria-live')).toBe('assertive');
  });

  it('Cmd+Shift+Enter is a no-op when the pane tree is a single leaf', async () => {
    await renderPage();
    // TerminalPage bootstraps with a single leaf tree on first spawn.
    expect(usePaneStore.getState().root?.kind).toBe('leaf');
    act(() => {
      triggerKey('Enter', { meta: true, shift: true });
    });
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });
});
