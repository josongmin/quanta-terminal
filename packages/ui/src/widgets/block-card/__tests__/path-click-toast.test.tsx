/**
 * Audit P1 (fix 5) — BlockCard surfaces a toast when `openInEditor` rejects.
 *
 * Scenarios:
 *   - Bridge rejects → `bridge-failed` toast appears with the clicked path.
 *   - No bridge installed → `no-bridge` toast appears.
 *   - Bridge accepts → NO toast is dispatched (silence on success).
 *
 * Strategy: render a BlockCard for a completed block whose output contains
 * a detectable `path:line:col`, install a stub HostBridge whose
 * `openInEditor` rejects, click the rendered path button, then assert the
 * ToastHost renders the expected message.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { useBlockStore } from '../../../entities/block/index.js';
import { BlockCard } from '../BlockCard.js';
import type { Block } from '../../../entities/block/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { ToastHost, useToastStore } from '../../../shared/ui/toast/index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

function makeStubBridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      return { sessionId: 'sess-stub', shell: '/bin/sh', cwd: '/' };
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
    subscribe() {
      return { unsubscribe: () => {} };
    },
    ...overrides,
  } as HostBridge;
}

/** Seed a completed block whose output contains a detectable `path:line:col`
 *  so the ANSI renderer wraps it in a clickable button. */
function seedBlockWithPath(): string {
  // Command text intentionally does NOT contain the path substring so the
  // role=button query below finds only the AnsiOutput path-link button, not
  // the header's block-toggle button (which carries the command text too).
  const id = useBlockStore.getState().createBlock('compile', '/repo');
  const out = new TextEncoder().encode('src/main.c:12:3: error: bad\n');
  useBlockStore.getState().appendBlockOutput(id, out);
  useBlockStore.getState().completeBlock(id, 1);
  return id;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useToastStore.getState().clearAll();
});

afterEach(() => {
  useToastStore.getState().clearAll();
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
  vi.restoreAllMocks();
});

describe('BlockCard path-click → toast on failure', () => {
  // NOTE on test ordering: `setHostBridge` mutates a module-level `injected`
  // variable as well as `window.__QUANTA_HOST__`. The window property can
  // be cleared from afterEach, but the module-level `injected` cannot be
  // reset from outside the module. We therefore run the no-bridge case FIRST
  // in the same file so it sees a truly empty bridge slot; subsequent tests
  // explicitly install a bridge and test the other paths.

  it('dispatches a no-bridge toast when no HostBridge is installed', async () => {
    const id = seedBlockWithPath();

    render(
      <>
        <BlockCard block={currentBlock(id)} />
        <ToastHost />
      </>,
    );

    const pathBtn = screen.getByRole('button', { name: /src\/main\.c/ });
    await act(async () => {
      fireEvent.click(pathBtn);
    });

    await waitFor(() => {
      expect(useToastStore.getState().items.length).toBeGreaterThan(0);
    });
    expect(useToastStore.getState().items[0]?.message).toMatch(
      /\$CODE_BIN|VS Code|Cursor/,
    );
  });

  it('dispatches a bridge-failed toast when openInEditor rejects', async () => {
    setHostBridge(
      makeStubBridge({
        openInEditor: vi.fn().mockRejectedValue(new Error('editor not found')),
      }),
    );
    const id = seedBlockWithPath();

    render(
      <>
        <BlockCard block={currentBlock(id)} />
        <ToastHost />
      </>,
    );

    const pathBtn = screen.getByRole('button', { name: /src\/main\.c/ });
    await act(async () => {
      fireEvent.click(pathBtn);
    });

    await waitFor(() => {
      expect(useToastStore.getState().items.length).toBeGreaterThan(0);
    });
    const items = useToastStore.getState().items;
    expect(items[0]?.kind).toBe('warning');
    expect(items[0]?.message).toMatch(/main\.c/);
    // The toast message should read as "editor didn't respond" (curly or
    // straight apostrophe depending on source) — the exact phrasing lives
    // in `openInEditorMessageForReason`.
    expect(items[0]?.message).toMatch(/didn['\u2019]t respond|respond/);
  });

  it('does NOT dispatch a toast on a successful open', async () => {
    const openSpy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(makeStubBridge({ openInEditor: openSpy }));
    const id = seedBlockWithPath();

    render(
      <>
        <BlockCard block={currentBlock(id)} />
        <ToastHost />
      </>,
    );

    const pathBtn = screen.getByRole('button', { name: /src\/main\.c/ });
    await act(async () => {
      fireEvent.click(pathBtn);
    });

    // Wait a microtask tick so the .then callback has a chance to run; even
    // after it fires, a successful result must NOT produce a toast.
    await Promise.resolve();
    await Promise.resolve();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().items).toHaveLength(0);
  });
});
