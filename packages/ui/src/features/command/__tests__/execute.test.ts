/**
 * `submitCommand` (command feature) unit tests.
 *
 * Covers:
 *   - Empty input → early return with reason=empty.
 *   - No session → reason=no-session without touching the bridge.
 *   - No bridge (neither injected nor installed) → reason=no-bridge.
 *   - Happy path: startBlock called (atomic), bridge.write with text + newline.
 *   - Cancels the previously-active block when a new submit lands.
 *   - Bridge write rejection surfaces write-failed AND marks the block errored.
 *   - Ordering: startBlock happens before bridge.write.
 *   - Atomicity under a synchronous pty_data emit from inside bridge.write:
 *     bytes must land in the NEW block, not the outgoing one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';
import { useSessionStore } from '../../../entities/session/index.js';
import type { BlockId } from '../../../shared/types/generated/index.js';
import { submitCommand } from '../execute.js';
import {
  bindBlockStore,
  type BlockStoreActions,
  type StartBlockPortOptions,
} from '../block-store-port.js';
import {
  appendToActiveBlock,
  installCommandRouter,
  __resetRouterForTests,
} from '../route-output.js';

function makeBridge(): { bridge: HostBridge; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockResolvedValue(undefined);
  const bridge = {
    ready: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn(),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as HostBridge;
  return { bridge, write };
}

interface MockStore extends BlockStoreActions {
  readonly startBlockMock: ReturnType<typeof vi.fn>;
  readonly errorBlockMock: ReturnType<typeof vi.fn>;
  readonly appendBlockOutputMock: ReturnType<typeof vi.fn>;
  readonly cancelHistory: BlockId[];
  activeSnapshot(): BlockId | null;
}

function makeMockStore(nextIds: readonly BlockId[] = ['blk-1' as BlockId]): MockStore {
  let cursor = 0;
  let active: BlockId | null = null;
  const cancelHistory: BlockId[] = [];
  const startBlockMock = vi.fn(
    (_text: string, _cwd: string, _opts?: StartBlockPortOptions): BlockId => {
      const id = (nextIds[cursor] ?? `blk-${cursor}`) as BlockId;
      cursor += 1;
      if (active !== null) cancelHistory.push(active);
      active = id;
      return id;
    },
  );
  const createBlockMock = vi.fn((_t: string, _c: string) => {
    const id = (nextIds[cursor] ?? `blk-${cursor}`) as BlockId;
    cursor += 1;
    return id;
  });
  const cancelBlockMock = vi.fn((id: BlockId) => {
    if (active === id) active = null;
  });
  const completeBlockMock = vi.fn((id: BlockId) => {
    if (active === id) active = null;
  });
  const errorBlockMock = vi.fn((id: BlockId) => {
    if (active === id) active = null;
  });
  const appendBlockOutputMock = vi.fn();
  const getRunningBlockIdsMock = vi.fn((): readonly BlockId[] => []);
  return {
    createBlock: createBlockMock,
    startBlock: startBlockMock,
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    cancelBlock: cancelBlockMock,
    completeBlock: completeBlockMock,
    errorBlock: errorBlockMock,
    appendBlockOutput: appendBlockOutputMock,
    getRunningBlockIds: getRunningBlockIdsMock,
    startBlockMock,
    errorBlockMock,
    appendBlockOutputMock,
    cancelHistory,
    activeSnapshot: () => active,
  };
}

let unbind: (() => void) | undefined;

beforeEach(() => {
  useSessionStore.getState().reset();
  __resetRouterForTests();
});

afterEach(() => {
  if (unbind) unbind();
  unbind = undefined;
});

describe('submitCommand', () => {
  it('returns reason=empty on blank input without creating a block', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    const { bridge, write } = makeBridge();
    const result = await submitCommand({ text: '   ', bridge });
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(store.startBlockMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('returns reason=no-bridge when nothing is injected or installed', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });
    const result = await submitCommand({ text: 'ls' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-bridge');
  });

  it('returns reason=no-session when session store has no id', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    const { bridge, write } = makeBridge();
    const result = await submitCommand({ text: 'ls', bridge });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-session');
    expect(store.startBlockMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('starts a block and writes the command with newline', async () => {
    const store = makeMockStore(['blk-a' as BlockId]);
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1', cwd: '/tmp/work' });
    const { bridge, write } = makeBridge();

    const result = await submitCommand({ text: 'ls -la', bridge });

    expect(result).toEqual({ ok: true, blockId: 'blk-a' });
    expect(store.startBlockMock).toHaveBeenCalledWith('ls -la', '/tmp/work', {
      sessionId: 'sess-1',
    });
    expect(write).toHaveBeenCalledWith('sess-1', 'ls -la\n');
    expect(store.activeSnapshot()).toBe('blk-a');
  });

  it('does not double the newline when input already ends with one', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });
    const { bridge, write } = makeBridge();

    await submitCommand({ text: 'pwd\n', bridge });

    expect(write).toHaveBeenCalledWith('sess-1', 'pwd\n');
  });

  it('cancels the previously-active block before opening the next (atomic)', async () => {
    const store = makeMockStore(['blk-1' as BlockId, 'blk-2' as BlockId]);
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });
    const { bridge } = makeBridge();

    const first = await submitCommand({ text: 'sleep 5', bridge });
    expect(first.ok).toBe(true);
    const second = await submitCommand({ text: 'echo hi', bridge });
    expect(second.ok).toBe(true);

    expect(store.cancelHistory).toEqual(['blk-1']);
    expect(store.activeSnapshot()).toBe('blk-2');
  });

  it('forwards watchdogMs into startBlock when provided', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });
    const { bridge } = makeBridge();
    await submitCommand({ text: 'ls', bridge, watchdogMs: 250 });
    expect(store.startBlockMock).toHaveBeenCalledWith('ls', '', {
      watchdogMs: 250,
      sessionId: 'sess-1',
    });
  });

  it('starts the block BEFORE calling bridge.write (ordering invariant)', async () => {
    const store = makeMockStore(['blk-a' as BlockId]);
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });

    const events: string[] = [];
    store.startBlockMock.mockImplementation((_t: string, _c: string) => {
      events.push('start');
      return 'blk-a' as BlockId;
    });
    const write = vi.fn(async () => {
      events.push('write');
    });
    const bridge = {
      ready: vi.fn(),
      spawn: vi.fn(),
      write,
      resize: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as HostBridge;

    await submitCommand({ text: 'ls', bridge });

    expect(events).toEqual(['start', 'write']);
  });

  it('falls back to session.cwd when no cwd is provided', async () => {
    const store = makeMockStore();
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1', cwd: '/home/me' });
    const { bridge } = makeBridge();

    await submitCommand({ text: 'ls', bridge });

    expect(store.startBlockMock).toHaveBeenCalledWith('ls', '/home/me', {
      sessionId: 'sess-1',
    });
  });

  it('surfaces write-failed and marks the block errored on bridge rejection', async () => {
    const store = makeMockStore(['blk-x' as BlockId]);
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });

    const write = vi.fn().mockRejectedValue(new Error('pipe closed'));
    const bridge = {
      ready: vi.fn(),
      spawn: vi.fn(),
      write,
      resize: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as HostBridge;

    const result = await submitCommand({ text: 'ls', bridge });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'write-failed') {
      expect(result.blockId).toBe('blk-x');
      expect(result.error.message).toBe('pipe closed');
    } else {
      throw new Error('expected write-failed result, got ' + JSON.stringify(result));
    }
    expect(store.errorBlockMock).toHaveBeenCalledWith(
      'blk-x',
      expect.stringContaining('pipe closed'),
    );
    expect(store.activeSnapshot()).toBeNull();
  });

  it('routes synchronous pty_data emitted during bridge.write to the correct block (atomicity)', async () => {
    // This is the Phase-2 race the atomic startBlock exists to close. The
    // mock bridge can emit pty_data synchronously from inside write(). If
    // cancel-previous + create + setActive weren't one mutation, those
    // bytes could land on the outgoing block or be dropped entirely.
    const store = makeMockStore(['blk-1' as BlockId, 'blk-2' as BlockId]);
    unbind = bindBlockStore(store);
    useSessionStore.getState().setSession({ id: 'sess-1' });

    const SESSION_ID = 'sess-1';
    const install = installCommandRouter(SESSION_ID);
    try {
      const write = vi.fn(async (_sessionId: string, text: string) => {
        const bytes = new TextEncoder().encode(`echo ${text.trim()}`);
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        const b64 = btoa(s);
        appendToActiveBlock(SESSION_ID, b64);
      });
      const bridge = {
        ready: vi.fn(),
        spawn: vi.fn(),
        write,
        resize: vi.fn(),
        close: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as HostBridge;

      const first = await submitCommand({ text: 'ls', bridge });
      expect(first.ok).toBe(true);
      expect(store.appendBlockOutputMock).toHaveBeenCalledWith(
        'blk-1',
        expect.any(Uint8Array),
      );

      store.appendBlockOutputMock.mockClear();
      const second = await submitCommand({ text: 'pwd', bridge });
      expect(second.ok).toBe(true);
      expect(store.appendBlockOutputMock).toHaveBeenCalledWith(
        'blk-2',
        expect.any(Uint8Array),
      );
      const blk1Appends = store.appendBlockOutputMock.mock.calls.filter(
        (c) => c[0] === 'blk-1',
      );
      expect(blk1Appends).toHaveLength(0);
    } finally {
      install.dispose();
    }
  });
});
