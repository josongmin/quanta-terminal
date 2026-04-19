/**
 * **Final E2E — composer submit → block lifecycle**
 *
 * End-to-end pipeline exercised with every production seam wired up:
 *
 *     submitCommand (features/command/execute) →
 *     startBlock on the REAL useBlockStore →
 *     bridge.write (test double; records bytes) →
 *     pty_data chunks fed through appendToActiveBlock (real router) →
 *     boundary detector closes the block when MOCK_PROMPT_BYTES arrives →
 *     BlockCard / BlockList re-render from the store
 *
 * The ONLY seams are:
 *   - A fake `HostBridge` (no real PTY). Its `write()` is a spy we assert
 *     against and (in one test) drives synchronous pty_data to prove the
 *     router bridge pipe works.
 *   - `__resetRouterForTests()` + `useBlockStore.resetAll()` between cases.
 *
 * Everything else — the block store, boundary detector, block-session lookup,
 * route-output router, BlockCard body subscription — is the production code.
 *
 * Covers the scenarios called out in the mission:
 *   1. submit → startBlock + bridge.write
 *   2. bridge.write receives "<text>\n" exactly
 *   3. pty_data → appendToActiveBlock → output in the store
 *   4. boundary bytes → completeBlock with exit 0
 *   5. pty_exit-style finalize → exit code propagates
 *   6. repeated submits → each gets its own block, previous one canceled
 *   7. cancelBlock → status 'canceled'
 *   8. empty submit → no block
 *   9. BlockCard renders "exit 0" once complete
 *  10. BlockList shows the new block once a session scope is passed
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEventListener,
  SessionId,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES, MOCK_PROMPT_BYTES } from '@quanta/host-common';

import { submitCommand } from '../../features/command/execute.js';
import { bindBlockEntity } from '../../features/command/bind-block-entity.js';
import {
  __resetRouterForTests,
  appendToActiveBlock,
  finalizeActiveBlock,
  installCommandRouter,
} from '../../features/command/route-output.js';
import { useBlockStore } from '../../entities/block/index.js';
import { useSessionStore } from '../../entities/session/index.js';
import { BlockCard } from '../../widgets/block-card/index.js';
import { BlockList } from '../../widgets/block-list/index.js';

const SESSION_ID = '01J00000000000000000000001' as SessionId;

// --- Fake bridge --------------------------------------------------------

interface TestBridge {
  readonly bridge: HostBridge;
  readonly write: ReturnType<typeof vi.fn>;
  readonly emit: (_listener?: HostEventListener) => void;
}

/**
 * Minimal HostBridge whose `write()` resolves synchronously (but is async).
 * One test swaps `write` for a variant that synchronously drives the router —
 * that's the path that used to race the active-block pointer.
 */
function makeBridge(overrides?: Partial<HostBridge>): TestBridge {
  const write = vi.fn().mockResolvedValue(undefined);
  const listeners = new Set<HostEventListener>();
  const bridge: HostBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      return { sessionId: SESSION_ID, shell: '/bin/sh', cwd: '/' };
    },
    write,
    async resize() {},
    async close() {},
    async cancelBlock() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async uninstallShellIntegration() {
      return {
        targetPath: '',
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
        id: '',
        command: '',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 0,
      };
    },
    subscribe(listener: HostEventListener) {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    ...overrides,
  } as HostBridge;
  return {
    bridge,
    write,
    emit: () => {
      /* tests drive appendToActiveBlock / finalizeActiveBlock directly */
    },
  };
}

// --- Helpers ------------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function textChunkB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

/**
 * A full mock-terminator chunk, optionally prefixed with payload bytes.
 * Mirrors what the Phase-1 mock bridge emits when a command completes.
 */
function terminatedChunkB64(prefix: string): string {
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(prefixBytes.length + MOCK_PROMPT_BYTES.length);
  combined.set(prefixBytes, 0);
  combined.set(MOCK_PROMPT_BYTES, prefixBytes.length);
  return bytesToB64(combined);
}

function getActiveBlockIdFromStore(): string | null {
  return useBlockStore.getState().activeBlockId;
}

function getBlockById(id: string) {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing from store`);
  return b;
}

// --- Setup / teardown ---------------------------------------------------

let unbindBlockEntity: (() => void) | undefined;
let disposeRouter: { dispose: () => void } | undefined;

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useSessionStore.getState().reset();
  __resetRouterForTests();
  // Wire the REAL adapter that fronts the real store. This is what
  // the page bootstrap does in production.
  unbindBlockEntity = bindBlockEntity();
  disposeRouter = installCommandRouter(SESSION_ID);
  useSessionStore.getState().setSession({ id: SESSION_ID, cwd: '/tmp/work' });
});

afterEach(() => {
  // Unmount any React trees before the store gets reset out from under them.
  cleanup();
  disposeRouter?.dispose();
  disposeRouter = undefined;
  unbindBlockEntity?.();
  unbindBlockEntity = undefined;
  __resetRouterForTests();
  useBlockStore.getState().resetAll();
  useSessionStore.getState().reset();
});

// --- Tests --------------------------------------------------------------

describe('composer submit → block lifecycle (e2e)', () => {
  it('submit creates a new running block and writes the command+newline to the bridge', async () => {
    const { bridge, write } = makeBridge();

    const result = await submitCommand({ text: 'echo hello', bridge });

    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(SESSION_ID, 'echo hello\n');

    if (!result.ok) throw new Error('expected ok=true');
    const block = getBlockById(result.blockId);
    expect(block.command).toBe('echo hello');
    expect(block.status).toBe('running');
    expect(block.cwd).toBe('/tmp/work');
    expect(getActiveBlockIdFromStore()).toBe(result.blockId);
  });

  it('passes the command bytes to bridge.write exactly (no double newline when input already ends with \\n)', async () => {
    const { bridge, write } = makeBridge();
    await submitCommand({ text: 'pwd\n', bridge });
    expect(write).toHaveBeenCalledWith(SESSION_ID, 'pwd\n');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('pty_data chunks arriving after submit land on the active block as output', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'echo hi', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    act(() => {
      appendToActiveBlock(SESSION_ID, textChunkB64('line one\n'));
      appendToActiveBlock(SESSION_ID, textChunkB64('line two\n'));
    });

    const block = getBlockById(result.blockId);
    expect(block.outputChunks.length).toBe(2);
    const decoded = new TextDecoder().decode(
      new Uint8Array(
        block.outputChunks.reduce(
          (acc, chunk) => acc.concat(Array.from(chunk)),
          [] as number[],
        ),
      ),
    );
    expect(decoded).toBe('line one\nline two\n');
    expect(block.status).toBe('running');
  });

  it('boundary bytes on the chunk close the block with exit 0 and clear the active pointer', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'echo done', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    act(() => {
      appendToActiveBlock(SESSION_ID, terminatedChunkB64('done\n'));
    });

    const block = getBlockById(result.blockId);
    expect(block.status).toBe('completed');
    expect(block.exitCode).toBe(0);
    expect(getActiveBlockIdFromStore()).toBeNull();
    // The terminator bytes themselves must NOT appear in the block output.
    const decoded = new TextDecoder().decode(
      new Uint8Array(
        block.outputChunks.reduce(
          (acc, c) => acc.concat(Array.from(c)),
          [] as number[],
        ),
      ),
    );
    expect(decoded).toBe('done\n');
  });

  it('finalizeActiveBlock (pty_exit path) transitions the active block to completed with the given exit code', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'false', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    act(() => {
      finalizeActiveBlock(SESSION_ID, 1, null);
    });

    const block = getBlockById(result.blockId);
    expect(block.status).toBe('completed');
    expect(block.exitCode).toBe(1);
    expect(getActiveBlockIdFromStore()).toBeNull();
  });

  it('consecutive submits each open a new block, and the previous one is canceled', async () => {
    const { bridge, write } = makeBridge();

    const first = await submitCommand({ text: 'sleep 5', bridge });
    if (!first.ok) throw new Error('expected first.ok=true');

    const second = await submitCommand({ text: 'echo hi', bridge });
    if (!second.ok) throw new Error('expected second.ok=true');

    expect(first.blockId).not.toBe(second.blockId);
    const firstBlock = getBlockById(first.blockId);
    const secondBlock = getBlockById(second.blockId);
    expect(firstBlock.status).toBe('canceled');
    expect(secondBlock.status).toBe('running');
    expect(getActiveBlockIdFromStore()).toBe(second.blockId);
    expect(write).toHaveBeenNthCalledWith(1, SESSION_ID, 'sleep 5\n');
    expect(write).toHaveBeenNthCalledWith(2, SESSION_ID, 'echo hi\n');
    // Blocks land in submission order.
    expect(useBlockStore.getState().order).toEqual([first.blockId, second.blockId]);
  });

  it('cancelBlock transitions a running block to canceled', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'sleep 10', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    act(() => {
      useBlockStore.getState().cancelBlock(result.blockId);
    });

    const block = getBlockById(result.blockId);
    expect(block.status).toBe('canceled');
    expect(getActiveBlockIdFromStore()).toBeNull();
  });

  it('empty / whitespace-only submit is a no-op: no block, no bridge.write, reason=empty', async () => {
    const { bridge, write } = makeBridge();

    const blank = await submitCommand({ text: '   ', bridge });
    const emptyStr = await submitCommand({ text: '', bridge });

    expect(blank).toEqual({ ok: false, reason: 'empty' });
    expect(emptyStr).toEqual({ ok: false, reason: 'empty' });
    expect(write).not.toHaveBeenCalled();
    expect(useBlockStore.getState().order).toEqual([]);
    expect(getActiveBlockIdFromStore()).toBeNull();
  });

  it('BlockCard renders the running → completed transition with the final exit code visible', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'echo hi', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    const block = getBlockById(result.blockId);
    render(<BlockCard block={block} />);
    // Running state: spinner label present, no exit code rendered yet.
    expect(screen.getByLabelText('Running')).toBeTruthy();
    expect(screen.queryByLabelText(/^Exit code /)).toBeNull();

    act(() => {
      appendToActiveBlock(SESSION_ID, terminatedChunkB64('hi\n'));
    });

    // BlockCard subscribes to the store's header view; the exit label
    // comes in synchronously once completeBlock runs.
    const exitLabel = screen.getByLabelText('Exit code 0');
    expect(exitLabel.textContent).toContain('exit 0');
  });

  it('BlockList renders new blocks for the active session scope and shows the command text', async () => {
    // The BlockList virtualizer asks the layout for pixel heights. jsdom
    // reports zero for everything, which collapses the visible-range set to
    // empty. Patch offset{Width,Height} on HTMLElement so the virtualizer
    // sees a real viewport — same trick BlockList's own test file uses.
    const origW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const origH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 600,
    });
    try {
      const { bridge } = makeBridge();

      const { container } = render(<BlockList sessionId={SESSION_ID} />);
      // Empty before any submit.
      expect(container.querySelector('[data-testid="block-list-empty"]')).not.toBeNull();

      await act(async () => {
        const r = await submitCommand({ text: 'ls -la', bridge });
        if (!r.ok) throw new Error('expected ok=true');
      });

      // After submit the list re-renders with the new block chrome mounted.
      const list = container.querySelector('[data-testid="block-list"]');
      expect(list).not.toBeNull();
      const activeId = getActiveBlockIdFromStore();
      expect(activeId).not.toBeNull();
      // Block row anchored by data-block-id uses the block id.
      const card = screen.getByTestId(`block-card-${activeId}`) as HTMLElement;
      // The card's header carries the command text.
      expect(card.textContent).toContain('ls -la');
      expect(card.dataset['status']).toBe('running');

      act(() => {
        appendToActiveBlock(SESSION_ID, terminatedChunkB64('out\n'));
      });

      expect(card.dataset['status']).toBe('completed');
    } finally {
      if (origW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origW);
      if (origH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origH);
    }
  });

  it('routes pty_data emitted synchronously from inside bridge.write() to the NEW block (atomicity under submit)', async () => {
    // This is the Phase-2 race the atomic startBlock exists to close. We
    // swap write() for a variant that inlines appendToActiveBlock — the
    // same shape the mock bridge uses.
    const write = vi.fn(async (_sessionId: SessionId, text: string) => {
      const chunk = `out:${text.trim()}\n`;
      appendToActiveBlock(SESSION_ID, textChunkB64(chunk));
    });
    const { bridge } = makeBridge({ write });

    const first = await submitCommand({ text: 'one', bridge });
    if (!first.ok) throw new Error('expected first.ok=true');
    const second = await submitCommand({ text: 'two', bridge });
    if (!second.ok) throw new Error('expected second.ok=true');

    const firstBlock = getBlockById(first.blockId);
    const secondBlock = getBlockById(second.blockId);

    const firstText = new TextDecoder().decode(
      new Uint8Array(
        firstBlock.outputChunks.reduce(
          (acc, c) => acc.concat(Array.from(c)),
          [] as number[],
        ),
      ),
    );
    const secondText = new TextDecoder().decode(
      new Uint8Array(
        secondBlock.outputChunks.reduce(
          (acc, c) => acc.concat(Array.from(c)),
          [] as number[],
        ),
      ),
    );
    expect(firstText).toBe('out:one\n');
    expect(secondText).toBe('out:two\n');
    // The first block was superseded; second is the live one.
    expect(firstBlock.status).toBe('canceled');
    expect(secondBlock.status).toBe('running');
  });

  it('finalize while no block is active is a silent no-op (no throw, no mutation)', () => {
    // No submit has occurred — there is nothing active to finalize. The
    // router must still accept the pty_exit without crashing.
    expect(useBlockStore.getState().order).toEqual([]);
    expect(() => {
      act(() => {
        finalizeActiveBlock(SESSION_ID, 0, null);
      });
    }).not.toThrow();
    expect(useBlockStore.getState().order).toEqual([]);
    expect(getActiveBlockIdFromStore()).toBeNull();
  });

  it('cross-chunk boundary (terminator split across two pty_data frames) still completes cleanly', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'echo split', bridge });
    if (!result.ok) throw new Error('expected ok=true');

    // Split MOCK_PROMPT_BYTES across two chunks, prefixed with payload.
    const split = 3;
    const prefixBytes = new TextEncoder().encode('split\n');
    const first = new Uint8Array(prefixBytes.length + split);
    first.set(prefixBytes, 0);
    first.set(MOCK_PROMPT_BYTES.subarray(0, split), prefixBytes.length);
    const second = MOCK_PROMPT_BYTES.subarray(split);

    act(() => {
      appendToActiveBlock(SESSION_ID, bytesToB64(first));
      appendToActiveBlock(SESSION_ID, bytesToB64(second));
    });

    const block = getBlockById(result.blockId);
    expect(block.status).toBe('completed');
    expect(block.exitCode).toBe(0);
    const decoded = new TextDecoder().decode(
      new Uint8Array(
        block.outputChunks.reduce(
          (acc, c) => acc.concat(Array.from(c)),
          [] as number[],
        ),
      ),
    );
    // Carry bytes that could have participated in the terminator must have
    // been held back and NOT leaked into the output.
    expect(decoded).toBe('split\n');
  });
});
