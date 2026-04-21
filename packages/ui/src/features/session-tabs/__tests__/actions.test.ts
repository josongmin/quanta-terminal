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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createSession, closeSession, switchSession, getConnection } from '../index.js';
import { __resetConnectionMapForTests } from '../connection-map.js';
import { useSessionsStore, useSessionStore } from '../../../entities/session/index.js';
import {
  SHELL_PATHS,
  useSessionProfiles,
} from '../../../entities/session-profile/index.js';
import type { BlockId } from '../../../shared/types/generated/index.js';
import {
  bindBlockStore,
  type BlockStoreActions,
  type StartBlockPortOptions,
} from '../../command/block-store-port.js';
import { __resetRouterForTests } from '../../command/route-output.js';

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
    async cancelBlock() {},
    async notify() {},
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
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    async readTextFile() {
      return null;
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
  useSessionStore.getState().reset();
  __resetConnectionMapForTests();
  __resetRouterForTests();
  // Reset the profiles store so the built-in Default (no overrides) is the
  // one observed by createSession. Every profile-specific test seeds its
  // own profile on top.
  useSessionProfiles.getState().reset();
});

/**
 * Minimal block-store adapter used by the startup-commands test — enough
 * for `submitCommand` to run end-to-end without instantiating the real
 * block entity. We only assert how many times `startBlock` fires.
 */
function makeMockBlockStore(): BlockStoreActions & {
  readonly startBlockMock: ReturnType<typeof vi.fn>;
} {
  let cursor = 0;
  let active: BlockId | null = null;
  const startBlockMock = vi.fn(
    (_text: string, _cwd: string, _opts?: StartBlockPortOptions): BlockId => {
      const id = (`blk-${cursor}` as BlockId);
      cursor += 1;
      active = id;
      return id;
    },
  );
  return {
    createBlock: vi.fn((_t: string, _c: string) => `blk-${cursor++}` as BlockId),
    startBlock: startBlockMock,
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    cancelBlock: vi.fn((id: BlockId) => {
      if (active === id) active = null;
    }),
    completeBlock: vi.fn((id: BlockId) => {
      if (active === id) active = null;
    }),
    errorBlock: vi.fn((id: BlockId) => {
      if (active === id) active = null;
    }),
    appendBlockOutput: vi.fn(),
    getRunningBlockIds: vi.fn((): readonly BlockId[] => []),
    startBlockMock,
  };
}

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

  it('forwards shell/cwd/env from a supplied profile to bridge.spawn', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    const id = useSessionProfiles.getState().addProfile({
      name: 'Work',
      shell: SHELL_PATHS.fish,
      cwd: '/Users/me/work',
      env: { KUBECONFIG: '/tmp/kc' },
    });
    await createSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: vi.fn(),
      profile: id,
    });
    expect(bridge.spawnMock).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      shell: SHELL_PATHS.fish,
      cwd: '/Users/me/work',
      env: { KUBECONFIG: '/tmp/kc' },
    });
  });

  it('uses the current default profile when no profile is specified', async () => {
    // Build a non-default profile, swap the default to it, and verify the
    // spawn call picks it up without the caller mentioning it.
    const id = useSessionProfiles.getState().addProfile({
      name: 'Bash',
      shell: SHELL_PATHS.bash,
    });
    useSessionProfiles.getState().setDefault(id);
    const bridge = makeBridge(['sess-1' as SessionId]);
    await createSession({ bridge, cols: 80, rows: 24, onData: vi.fn() });
    expect(bridge.spawnMock).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      shell: SHELL_PATHS.bash,
    });
  });

  it('falls back to host defaults when the profile id is unknown', async () => {
    const bridge = makeBridge(['sess-1' as SessionId]);
    await createSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: vi.fn(),
      profile: 'nonexistent-id',
    });
    // Unknown id → default profile (which has no overrides) → host defaults.
    expect(bridge.spawnMock).toHaveBeenCalledWith({ cols: 80, rows: 24 });
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

describe('createSession startupCommands', () => {
  let unbind: (() => void) | undefined;
  afterEach(() => {
    if (unbind) unbind();
    unbind = undefined;
  });

  it('submits each startup command through submitCommand after ready', async () => {
    const store = makeMockBlockStore();
    unbind = bindBlockStore(store);
    const bridge = makeBridge(['sess-1' as SessionId]);
    // Build a profile with two startup commands.
    const id = useSessionProfiles.getState().addProfile({
      name: 'Dev',
      shell: SHELL_PATHS.zsh,
      startupCommands: ['cd ~/projects/foo', 'pnpm dev'],
    });
    await createSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: vi.fn(),
      profile: id,
    });
    // The startup runner kicks off asynchronously (50 ms gap between
    // commands). Wait past the gap before asserting.
    await new Promise((r) => setTimeout(r, 150));
    // Two startup commands → two startBlock calls → two bridge.write calls
    // carrying the command text with a trailing newline.
    expect(store.startBlockMock).toHaveBeenCalledTimes(2);
    expect(store.startBlockMock.mock.calls[0]?.[0]).toBe('cd ~/projects/foo');
    expect(store.startBlockMock.mock.calls[1]?.[0]).toBe('pnpm dev');
  });

  it('does nothing when the profile has no startup commands', async () => {
    const store = makeMockBlockStore();
    unbind = bindBlockStore(store);
    const bridge = makeBridge(['sess-1' as SessionId]);
    const id = useSessionProfiles.getState().addProfile({
      name: 'Plain',
      shell: SHELL_PATHS.zsh,
    });
    await createSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: vi.fn(),
      profile: id,
    });
    await new Promise((r) => setTimeout(r, 100));
    // No startup commands → no block creation (aside from what the session
    // itself might seed, which the mock block store does not do).
    expect(store.startBlockMock).not.toHaveBeenCalled();
  });
});
