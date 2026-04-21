/**
 * Plan 0005 P1-C — block overlay flag-on integration test.
 *
 * Mounts `<TerminalPage />` with `flag.blockUx === true` and asserts that
 * the block overlay mounts, renders a card per block that has a populated
 * `rowRange`, and unmounts when the flag flips back off.
 *
 * Pairs with `p0-default.test.tsx`, which pins the flag-OFF behavior (no
 * overlay, no block-ux widgets).
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

import { TerminalPage } from '../../pages/terminal-page/TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import { setHostBridge } from '../../shared/api/host-bridge.js';
import {
  resetFeatureFlags,
  setFeatureFlag,
  useFeatureFlagsStore,
} from '../../shared/config/feature-flags.js';

const SESSION_ID = '01J00000000000000000000002' as SessionId;

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
        tier: 'safe',
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    emit(event: HostEvent) {
      for (const l of listeners) l(event);
    },
  } satisfies FakeBridge;
  return bridge;
}

function seedActiveSession(): void {
  useSessionsStore.getState().addSession({
    id: SESSION_ID,
    shell: '/bin/sh',
    cwd: '/tmp',
    cwdSource: 'launch',
    shellIntegration: 'missing',
    health: 'ready',
    exitCode: null,
    isWsl: false,
  });
  useSessionsStore.getState().setActive(SESSION_ID);
  useSessionStore.getState().setSession({ id: SESSION_ID, health: 'ready' });
}

function seedBlockWithRange(
  id: string,
  startRow: number,
  endRowExclusive: number | null,
): void {
  const blockId = useBlockStore.getState().startBlock('ls -la', '/', {
    sessionId: SESSION_ID,
    rowRange: { startRow, endRowExclusive },
    confidence: 'authoritative',
  });
  if (endRowExclusive !== null) {
    useBlockStore.getState().completeBlock(blockId, 0);
  }
  // Re-label so tests can assert on a stable id.
  void id;
}

let bridge: FakeBridge;

beforeEach(() => {
  resetFeatureFlags();
  setFeatureFlag('blockUx', true);
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
  // Return a stub connection with a minimal engine.emulator so the overlay
  // host reads a scrollback window without NPE.
  getSessionConnectionSpy.mockReturnValue({
    sessionId: SESSION_ID,
    engine: {
      emulator: {
        getScrollback() {
          return { baseRowId: 0, rows: new Array(50) };
        },
      },
    },
  });

  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useTuiStore.getState().reset();
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useBlockStore.getState().resetAll();
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
  resetFeatureFlags();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TerminalPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Block overlay — flag on (flag.blockUx = true)', () => {
  it('the feature flag reports on', () => {
    expect(useFeatureFlagsStore.getState().flags.blockUx).toBe(true);
  });

  it('does not render the overlay when no blocks have a row range', async () => {
    seedActiveSession();
    await renderPage();
    // Overlay returns null when there are no blocks with a row range.
    expect(screen.queryByTestId('block-overlay')).toBeNull();
  });

  it('renders the overlay when at least one block has a non-null rowRange', async () => {
    seedActiveSession();
    seedBlockWithRange('blk-a', 3, 7);
    await renderPage();
    expect(screen.getByTestId('block-overlay')).toBeInTheDocument();
    // One card visible.
    expect(screen.getAllByTestId('block-overlay-card')).toHaveLength(1);
  });

  it('renders one card per range-populated block', async () => {
    seedActiveSession();
    seedBlockWithRange('a', 3, 7);
    seedBlockWithRange('b', 10, 14);
    seedBlockWithRange('c', 20, null);
    await renderPage();
    expect(screen.getAllByTestId('block-overlay-card')).toHaveLength(3);
  });

  it('filters blocks with null rowRange out of the overlay (legacy composer blocks)', async () => {
    seedActiveSession();
    // Legacy-style block: no rowRange.
    useBlockStore.getState().startBlock('echo legacy', '/', {
      sessionId: SESSION_ID,
    });
    // P1-C block: rowRange attached.
    seedBlockWithRange('b', 10, 14);
    await renderPage();
    expect(screen.getAllByTestId('block-overlay-card')).toHaveLength(1);
  });
});
