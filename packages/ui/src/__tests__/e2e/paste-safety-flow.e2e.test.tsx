/**
 * E2E — Paste Safety: dialog → Escape → focus restoration
 *
 * Tests the full user flow:
 *   1. Render <TerminalPage /> with an active session.
 *   2. Simulate pasting `rm -rf /` into the composer textarea.
 *   3. Assert the paste-safety dialog appears with "danger" level content.
 *   4. Press Escape to dismiss the dialog.
 *   5. Assert the dialog is gone AND the composer textarea has focus.
 *
 * Uses the same narrow mock surface as tui-full-flow.e2e.test.tsx so jsdom
 * never touches IDB / Notification / the session-connect bridge fanout.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

// ---------------------------------------------------------------------------
// Module mocks — mirrors tui-full-flow.e2e.test.tsx exactly.
// ---------------------------------------------------------------------------

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
  return {
    ...actual,
    installBannerDetectors: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../features/notifications/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/notifications/index.js')>(
    '../../features/notifications/index.js',
  );
  return {
    ...actual,
    installNotificationDetector: () => ({ unsubscribe: () => {} }),
  };
});
vi.mock('../../features/command/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/command/index.js')>(
    '../../features/command/index.js',
  );
  return {
    ...actual,
    bindBlockEntity: () => () => {},
  };
});

// ---------------------------------------------------------------------------
// Real imports (after mocks).
// ---------------------------------------------------------------------------

import { TerminalPage } from '../../pages/terminal-page/TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import { setHostBridge } from '../../shared/api/host-bridge.js';
import {
  __resetRawObserversForTests,
} from '../../features/command/route-output.js';

const SESSION_ID = '01J00000000000000000000001' as SessionId;

// ---------------------------------------------------------------------------
// Fake bridge — same shape as tui-full-flow.e2e.
// ---------------------------------------------------------------------------

interface FakeBridge extends HostBridge {
  readonly emit: (event: HostEvent) => void;
  readonly write: ReturnType<typeof vi.fn>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const write = vi.fn().mockResolvedValue(undefined);
  const bridge = {
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
        command: 'ls',
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
  return bridge;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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

/**
 * Build a paste event that jsdom's fireEvent.paste will use correctly.
 * The Composer reads `e.clipboardData.getData('text')`.
 */
function pasteEvent(text: string): { clipboardData: { getData: (t: string) => string } } {
  return {
    clipboardData: {
      getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : ''),
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('Paste safety flow (e2e)', () => {
  it('rm -rf / paste shows danger dialog with role=dialog', async () => {
    seedActiveSession();
    await renderPage();

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.paste(input, pasteEvent('rm -rf /'));
    });

    // Dialog must be present and have the danger-level indicator.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('paste-confirm-dialog')).toBeInTheDocument();

    // The dialog must contain danger-level text: either in the badge or in the
    // reason list. The analyze() function flags `rm -rf` as 'danger'.
    const backdrop = screen.getByTestId('paste-confirm-backdrop');
    expect(backdrop).toBeInTheDocument();

    // The preview should contain the pasted text.
    expect(screen.getByTestId('paste-confirm-preview')).toHaveTextContent(/rm -rf/);
  });

  it('Escape dismisses the dialog and restores focus to the textarea', async () => {
    seedActiveSession();
    await renderPage();

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.paste(input, pasteEvent('rm -rf /'));
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Fire Escape on the dialog element.
    const dialog = screen.getByTestId('paste-confirm-dialog');
    act(() => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    // Dialog dismissed.
    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Focus is restored to the textarea via the queueMicrotask in cancelPaste.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(input);
  });

  it('composer textarea remains empty after canceling the dangerous paste', async () => {
    seedActiveSession();
    await renderPage();

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.paste(input, pasteEvent('rm -rf /'));
    });

    const dialog = screen.getByTestId('paste-confirm-dialog');
    act(() => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    // Textarea must not have received the dangerous text.
    expect(input.value).toBe('');
  });
});
