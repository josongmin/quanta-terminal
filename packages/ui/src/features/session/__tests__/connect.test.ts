/**
 * Session connect feature tests.
 *
 * Focus:
 *   - We subscribe BEFORE spawn resolves so events emitted during the spawn
 *     await window are not dropped.
 *   - `close()` unsubscribes (cleanup assertion — the brief requires every
 *     subscription have a matching teardown that's tested).
 *   - `pty_data` for unknown sessions is dropped; our own session is
 *     dispatched.
 *   - A failed spawn unsubscribes so we don't leak listeners.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SpawnSessionOptions,
  SpawnSessionResult,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { connectSession } from '../connect.js';
import { useSessionStore } from '../../../entities/session/index.js';

interface ScriptedBridge extends HostBridge {
  emit: (event: HostEvent) => void;
  listenerCount: () => number;
}

function makeBridge(spawnResult: Partial<SpawnSessionResult> = {}): ScriptedBridge {
  const listeners = new Set<HostEventListener>();
  const bridge: ScriptedBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return {
        sessionId: (spawnResult.sessionId ?? 'sess-1') as SessionId,
        shell: spawnResult.shell ?? '/bin/zsh',
        cwd: spawnResult.cwd ?? options.cwd ?? '/',
      };
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
        tier: 'safe',
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
    emit(event: HostEvent) {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
  };
  return bridge;
}

describe('connectSession', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes before spawn resolves so early pty_data is not dropped', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const onData = vi.fn();

    // Wrap spawn so we can emit an event BEFORE it resolves.
    const origSpawn = bridge.spawn;
    bridge.spawn = async (options) => {
      // Simulate the host emitting pty_data synchronously during spawn (race).
      bridge.emit({
        kind: 'pty_data',
        sessionId: 'sess-1',
        seq: 0,
        bytesB64: 'aGVsbG8=',
      });
      return origSpawn(options);
    };

    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData });
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('aGVsbG8=');
    await conn.close();
  });

  it('filters events to the owning session', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const onData = vi.fn();
    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData });

    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-99',
      seq: 0,
      bytesB64: 'ignored',
    });
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-1',
      seq: 1,
      bytesB64: 'kept',
    });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('kept');
    await conn.close();
  });

  it('close() unsubscribes from the bridge', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    expect(bridge.listenerCount()).toBe(1);
    await conn.close();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('close() is idempotent', async () => {
    const bridge = makeBridge();
    const closeSpy = vi.spyOn(bridge, 'close');
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    await conn.close();
    await conn.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when spawn rejects so the listener does not leak', async () => {
    const bridge = makeBridge();
    bridge.spawn = async () => {
      throw new Error('spawn failed');
    };
    await expect(connectSession({ bridge, cols: 80, rows: 24, onData: () => {} })).rejects.toThrow(
      'spawn failed',
    );
    expect(bridge.listenerCount()).toBe(0);
  });

  it('handles session_cwd_changed and updates the store', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    bridge.emit({
      kind: 'session_cwd_changed',
      sessionId: 'sess-1',
      cwd: '/tmp/x',
      source: 'osc7',
    });
    expect(useSessionStore.getState().cwd).toBe('/tmp/x');
    expect(useSessionStore.getState().cwdSource).toBe('osc7');
    await conn.close();
  });

  it('allows session-less events through (undefined sessionId)', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    // A synthetic future event with no sessionId must not be filtered out.
    // Pattern: use a shape that matches a known kind but omit sessionId.
    // We emit a session_cwd_changed WITHOUT sessionId (cast through unknown).
    const sessionless = {
      kind: 'session_cwd_changed' as const,
      cwd: '/etc',
      source: 'osc7' as const,
    } as unknown as HostEvent;
    bridge.emit(sessionless);
    expect(useSessionStore.getState().cwd).toBe('/etc');
    await conn.close();
  });

  it('pty_exit with signal-only exit marks session health=error (crash path)', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    bridge.emit({
      kind: 'pty_exit',
      sessionId: 'sess-1',
      exitCode: null,
      signal: 'SIGSEGV',
    });
    const state = useSessionStore.getState();
    expect(state.health).toBe('error');
    expect(state.exitCode).toBeNull();
    await conn.close();
  });

  it('pty_exit with exit code > 128 marks session health=error (crash path)', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    bridge.emit({
      kind: 'pty_exit',
      sessionId: 'sess-1',
      exitCode: 139, // 128 + SIGSEGV
      signal: null,
    });
    const state = useSessionStore.getState();
    expect(state.health).toBe('error');
    expect(state.exitCode).toBe(139);
    await conn.close();
  });

  it('pty_exit with clean exit marks session exited (not error)', async () => {
    const bridge = makeBridge({ sessionId: 'sess-1' as SessionId });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    bridge.emit({
      kind: 'pty_exit',
      sessionId: 'sess-1',
      exitCode: 0,
      signal: null,
    });
    const state = useSessionStore.getState();
    expect(state.health).toBe('exited');
    expect(state.exitCode).toBe(0);
    await conn.close();
  });

  it('close racing a second close is still idempotent (StrictMode-safe)', async () => {
    const bridge = makeBridge();
    const closeSpy = vi.spyOn(bridge, 'close');
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    // Two concurrent close() calls (mirrors StrictMode's double-invoked effect
    // cleanup). Only ONE bridge.close must be issued.
    await Promise.all([conn.close(), conn.close()]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount()).toBe(0);
  });
});
