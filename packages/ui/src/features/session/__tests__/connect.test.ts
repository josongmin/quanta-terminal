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
  BlockId,
  HostBridge,
  HostEvent,
  HostEventListener,
  SpawnSessionOptions,
  SpawnSessionResult,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES, MOCK_PROMPT_BYTES } from '@quanta/host-common';
import { connectSession } from '../connect.js';
import { useSessionStore } from '../../../entities/session/index.js';
import { bindBlockStore, type BlockStoreActions } from '../../command/index.js';
import { __resetRouterForTests } from '../../command/route-output.js';

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

// ------------------------------------------------------------------
// Boundary-detector selection by bridge kind (real-shell mangling fix).
// ------------------------------------------------------------------
//
// connectSession() must install the command router such that a REAL
// shell (non-`/bin/mock` spawn) does NOT run the mock-prompt boundary
// detector. Without this gating, zsh output that happens to contain
// `MOCK_PROMPT_BYTES` (e.g. a coloured `$` glyph in an oh-my-zsh themed
// prompt) would mis-close the active block and drop the bytes that
// follow, producing the user-visible "ls → lls", "cd data → s" / "cd d"
// command-mangling symptoms.
//
// Conversely, the mock bridge (shell `/bin/mock`) MUST still observe
// mock-prompt closes, otherwise the in-browser dev flow would leave
// every block permanently open. The two tests below pin both sides of
// that selection.
describe('connectSession — boundary-detector selection by bridge kind', () => {
  // Small helper: stateful fake block store that records appends +
  // completeBlock calls so we can observe what the router did with
  // the pty_data bytes.
  function makeBlockRecorder() {
    let active: BlockId | null = null;
    const appends: Array<{ id: BlockId; bytes: Uint8Array }> = [];
    const completes: Array<{ id: BlockId; exitCode: number | null }> = [];
    const store: BlockStoreActions = {
      createBlock: vi.fn(() => 'blk-unused' as BlockId),
      startBlock: vi.fn(() => 'blk-unused' as BlockId),
      setActiveBlockId: (id) => {
        active = id;
      },
      getActiveBlockId: () => active,
      appendBlockOutput: (id, chunk) => {
        appends.push({ id, bytes: new Uint8Array(chunk) });
      },
      completeBlock: (id, exitCode) => {
        completes.push({ id, exitCode });
        if (active === id) active = null;
      },
      cancelBlock: vi.fn(),
      errorBlock: vi.fn(),
      getRunningBlockIds: vi.fn(() => [] as readonly BlockId[]),
    };
    return {
      store,
      appends,
      completes,
      setActive: (id: BlockId | null) => {
        active = id;
      },
    };
  }

  // Build base64 for an arbitrary Uint8Array payload. `btoa` is available
  // under jsdom (what @quanta/ui tests run on).
  function toB64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  // "hello" + the mock-prompt terminator — the exact pattern that would
  // trigger a premature close under the legacy detector.
  function helloThenMockPromptB64(): string {
    const helloBytes = new TextEncoder().encode('hello');
    const buf = new Uint8Array(helloBytes.length + MOCK_PROMPT_BYTES.length);
    buf.set(helloBytes, 0);
    buf.set(MOCK_PROMPT_BYTES, helloBytes.length);
    return toB64(buf);
  }

  let unbind: (() => void) | undefined;
  beforeEach(() => {
    __resetRouterForTests();
    useSessionStore.getState().reset();
  });
  afterEach(() => {
    if (unbind) unbind();
    unbind = undefined;
    __resetRouterForTests();
  });

  it('real-shell spawn (shell !== /bin/mock): mock-prompt bytes do NOT close the block', async () => {
    const rec = makeBlockRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge({
      sessionId: 'sess-real' as SessionId,
      shell: '/bin/zsh',
    });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });

    // Simulate the UI opening a block right after connect (what submitCommand
    // would do), then the shell emitting a chunk that contains the mock
    // terminator as a false-positive.
    rec.setActive('blk-real' as BlockId);
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-real',
      seq: 0,
      bytesB64: helloThenMockPromptB64(),
    });

    // The real-shell install path should have passed `detector: null`, so
    // the whole chunk flows verbatim and the block stays open.
    expect(rec.completes).toHaveLength(0);
    expect(rec.appends).toHaveLength(1);
    // 5 ("hello") + 11 (MOCK_PROMPT_BYTES) = 16 bytes.
    expect(rec.appends[0]!.bytes.length).toBe(16);
    expect(rec.store.getActiveBlockId()).toBe('blk-real');

    await conn.close();
  });

  it('mock bridge spawn (shell === /bin/mock): mock-prompt bytes DO close the block (legacy)', async () => {
    // Backwards-compat guard: the in-browser mock workflow relies on the
    // mock boundary detector to close each command's block. If a future
    // change flips the default the wrong way, the dev mock UI would
    // silently break — this test pins it.
    const rec = makeBlockRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge({
      sessionId: 'sess-mock' as SessionId,
      shell: '/bin/mock',
    });
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });

    rec.setActive('blk-mock' as BlockId);
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-mock',
      seq: 0,
      bytesB64: helloThenMockPromptB64(),
    });

    // Mock bridge → mock detector → block closes, pre-boundary bytes land.
    expect(rec.completes).toEqual([{ id: 'blk-mock', exitCode: 0 }]);
    // "hello" appended; the 11 terminator bytes are consumed by the
    // detector and NOT forwarded as output.
    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0]!.bytes.length).toBe(5);

    await conn.close();
  });
});
