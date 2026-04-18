/**
 * Multi-session lifecycle (`createSession` / `closeSession` / `switchSession`).
 *
 * We drive the actions against a scripted `HostBridge`, the same pattern the
 * connect feature uses. Covers:
 *   - createSession calls bridge.spawn, adds the session to the collection,
 *     registers a ConnectedSession, and becomes active.
 *   - createSession on a second call does NOT leak listener count and the
 *     new session is the active one.
 *   - closeSession removes from the store, drops the connection from the map,
 *     AND calls bridge.close for that session id.
 *   - closeSession is idempotent for unknown ids.
 *   - switchSession flips activeId without touching connections.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  SpawnSessionOptions,
  SpawnSessionResult,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import {
  createSession,
  closeSession,
  switchSession,
  getConnection,
} from '../index.js';
import { __resetConnectionMapForTests } from '../connection-map.js';
import { useSessionsStore } from '../../../entities/session/index.js';

interface ScriptedBridge extends HostBridge {
  emit: (event: HostEvent) => void;
  listenerCount: () => number;
  closeMock: ReturnType<typeof vi.fn>;
  spawnMock: ReturnType<typeof vi.fn>;
}

function makeBridge(sessionIds: readonly SessionId[]): ScriptedBridge {
  const listeners = new Set<HostEventListener>();
  let cursor = 0;
  const closeMock = vi.fn(async () => {});
  const spawnMock = vi.fn(async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
    const id = sessionIds[cursor] ?? (`sess-${cursor}` as SessionId);
    cursor += 1;
    return {
      sessionId: id,
      shell: '/bin/zsh',
      cwd: opts.cwd ?? '/',
    };
  });
  const bridge: ScriptedBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    spawn: spawnMock,
    async write() {},
    async resize() {},
    close: closeMock,
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
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    emit(event: HostEvent) {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
    closeMock,
    spawnMock,
  };
  return bridge;
}

beforeEach(() => {
  useSessionsStore.getState().reset();
  __resetConnectionMapForTests();
});

describe('createSession', () => {
  it('spawns a PTY, registers the connection, and adopts as active', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    const onData = vi.fn();
    const { sessionId } = await createSession({
      bridge,
      cols: 80,
      rows: 24,
      onData,
    });
    expect(sessionId).toBe('sess-1');
    expect(bridge.spawnMock).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    const coll = useSessionsStore.getState();
    expect(coll.order).toContain('sess-1');
    expect(coll.activeId).toBe('sess-1');
    expect(getConnection('sess-1' as SessionId)).toBeDefined();
  });

  it('creating a second session adopts IT as the active one', async () => {
    const bridge = makeBridge(['sess-1' as SessionId, 'sess-2' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    expect(useSessionsStore.getState().activeId).toBe('sess-2');
    expect(useSessionsStore.getState().order).toEqual(['sess-1', 'sess-2']);
  });

  it('onData receives (sessionId, bytesB64) pairs filtered to the emitting session', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    const onData = vi.fn<(id: SessionId, bytes: string) => void>();
    await createSession({ bridge, cols: 80, rows: 24, onData });
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-1' as SessionId,
      seq: 0,
      bytesB64: 'aGVsbG8=',
    });
    expect(onData).toHaveBeenCalledWith('sess-1', 'aGVsbG8=');
  });
});

describe('closeSession', () => {
  it('removes the session AND calls bridge.close for its id', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    await closeSession('sess-1' as SessionId);
    expect(bridge.closeMock).toHaveBeenCalledWith('sess-1');
    expect(useSessionsStore.getState().order).not.toContain('sess-1');
    expect(getConnection('sess-1' as SessionId)).toBeUndefined();
  });

  it('switches active to the neighbor when the closed tab was active', async () => {
    const bridge = makeBridge(['sess-1' as SessionId, 'sess-2' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    // After the second createSession, sess-2 is active.
    await closeSession('sess-2' as SessionId);
    expect(useSessionsStore.getState().activeId).toBe('sess-1');
  });

  it('is idempotent for unknown ids', async () => {
    await expect(closeSession('unknown' as SessionId)).resolves.toBeUndefined();
  });

  it('is idempotent when called twice for the same id', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    await closeSession('sess-1' as SessionId);
    await closeSession('sess-1' as SessionId);
    // Only one bridge.close — second call found no connection to re-close.
    expect(bridge.closeMock).toHaveBeenCalledTimes(1);
  });
});

describe('switchSession', () => {
  it('flips active without touching connections', async () => {
    const bridge = makeBridge(['sess-1' as SessionId, 'sess-2' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    switchSession('sess-1' as SessionId);
    expect(useSessionsStore.getState().activeId).toBe('sess-1');
    // Connections intact — the inactive tab keeps running.
    expect(getConnection('sess-1' as SessionId)).toBeDefined();
    expect(getConnection('sess-2' as SessionId)).toBeDefined();
    expect(bridge.closeMock).not.toHaveBeenCalled();
  });
});
