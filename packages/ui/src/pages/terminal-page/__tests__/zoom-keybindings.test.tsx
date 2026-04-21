/**
 * Zoom keybinding tests — Cmd+= / Cmd+- / Cmd+0 integrate with the zoom
 * store via the global keymap. The TerminalPage's boot effect mounts the
 * bindings; we drive them with synthetic keydown events.
 *
 * We reuse the heavy mock harness from `TerminalPage.test.tsx` so the page
 * mounts without spawning a real bridge.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../widgets/terminal-shell/index.js', async () => {
  const React = await import('react');
  return {
    TerminalShell: React.forwardRef<{ focus(): void; blur(): void }, unknown>(
      function TerminalShellStub(_props, ref) {
        React.useImperativeHandle(ref, () => ({ focus: () => {}, blur: () => {} }));
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
vi.mock('../../../features/session-tabs/index.js', () => ({
  createSession: vi.fn(async () => ({ sessionId: 'mock-sess', connection: {} })),
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
import { useZoomStore, ZOOM_DEFAULT, ZOOM_STEP } from '../../../features/zoom/index.js';
import { __resetKeymapForTests } from '../../../shared/lib/keymap.js';

function triggerKey(key: string, opts: { meta?: boolean; ctrl?: boolean } = {}): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
}

// The keymap uses `isMac()` to resolve `mod`; jsdom's navigator.platform is
// typically empty. We set it to a Mac-like value so `meta` resolves `mod`.
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

describe('TerminalPage zoom keybindings', () => {
  let unpin: () => void;

  beforeEach(() => {
    unpin = pinMacPlatform();
    __resetKeymapForTests();
    useZoomStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    unpin();
    __resetKeymapForTests();
    useZoomStore.getState().reset();
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

  it('Cmd+= zooms in', async () => {
    await renderPage();
    act(() => {
      triggerKey('=', { meta: true });
    });
    expect(useZoomStore.getState().zoomLevel).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 2);
  });

  it('Cmd+- zooms out', async () => {
    await renderPage();
    act(() => {
      triggerKey('-', { meta: true });
    });
    expect(useZoomStore.getState().zoomLevel).toBeCloseTo(ZOOM_DEFAULT - ZOOM_STEP, 2);
  });

  it('Cmd+0 resets zoom', async () => {
    await renderPage();
    act(() => {
      useZoomStore.getState().zoomIn();
      useZoomStore.getState().zoomIn();
    });
    act(() => {
      triggerKey('0', { meta: true });
    });
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_DEFAULT);
  });

  it('applies the zoom level as a CSS variable on <html>', async () => {
    await renderPage();
    act(() => {
      triggerKey('=', { meta: true });
    });
    expect(document.documentElement.style.getPropertyValue('--q-zoom')).toBe(
      String(useZoomStore.getState().zoomLevel),
    );
  });
});
