/**
 * Integration: `features/session/connect` + `features/command/route-output`.
 *
 * Why this test lives in the command slice and not under session:
 *   - It asserts the SESSION feature routes events THROUGH the command
 *     feature. The router is the subject under test; connect is the driver.
 *   - Keeps the session tests free of block-store mocks.
 *
 * Guarantees under test:
 *   - connectSession installs a per-session router automatically so pty_data
 *     lands on appendToActiveBlock for the correct session.
 *   - pty_exit causes finalizeActiveBlock to close the active block AND
 *     cancel any stragglers.
 *   - conn.close disposes the scoped router so later events don't route.
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
// Cross-slice (test-only): this integration test asserts the session feature
// calls INTO the command feature on pty events. Production imports in that
// direction are also slice-exempted with the same rationale.
import { connectSession } from '../../session/connect.js'; // FIXME(fsd-layer-skip): integration test exercises session → command router crossing
import { useSessionStore } from '../../../entities/session/index.js';
import { __resetRouterForTests } from '../route-output.js';
import { bindBlockStore, type BlockStoreActions } from '../block-store-port.js';
import type { BlockId } from '../../../shared/types/generated/index.js';

interface ScriptedBridge extends HostBridge {
  emit: (event: HostEvent) => void;
}

function makeBridge(sessionId: SessionId = 'sess-int' as SessionId): ScriptedBridge {
  const listeners = new Set<HostEventListener>();
  const bridge: ScriptedBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(_options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return {
        sessionId,
        shell: '/bin/zsh',
        cwd: '/tmp',
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
        fileMissing: true,
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
    emit(event) {
      for (const l of listeners) l(event);
    },
  };
  return bridge;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function makeRecorder() {
  const appends: Uint8Array[] = [];
  const completed: Array<{ id: BlockId; exitCode: number | null }> = [];
  const canceled: BlockId[] = [];
  let running: readonly BlockId[] = [];
  let active: BlockId | null = null;
  const store: BlockStoreActions = {
    createBlock: vi.fn(() => 'blk-int' as BlockId),
    startBlock: vi.fn(() => {
      active = 'blk-int' as BlockId;
      return active;
    }),
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    appendBlockOutput: (_id, chunk) => {
      appends.push(new Uint8Array(chunk));
    },
    completeBlock: (id, exitCode) => {
      completed.push({ id, exitCode });
      if (active === id) active = null;
    },
    cancelBlock: (id) => {
      canceled.push(id);
      if (active === id) active = null;
    },
    errorBlock: vi.fn(),
    getRunningBlockIds: () => running,
  };
  return {
    store,
    appends,
    completed,
    canceled,
    setActive: (id: BlockId | null) => {
      active = id;
    },
    setRunning: (ids: readonly BlockId[]) => {
      running = ids;
    },
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
  vi.restoreAllMocks();
});

describe('session.connect → command.router wiring', () => {
  it('routes pty_data into the active block when connectSession auto-installs the router', async () => {
    const rec = makeRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge();
    const onData = vi.fn();
    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData });
    rec.setActive('blk-int' as BlockId);

    bridge.emit({
      kind: 'pty_data',
      sessionId: conn.sessionId,
      seq: 1,
      bytesB64: 'Zm9v', // 'foo'
    });

    expect(rec.appends).toHaveLength(1);
    const first = rec.appends[0];
    if (!first) throw new Error('expected one append');
    expect(bytesToText(first)).toBe('foo');
    expect(onData).toHaveBeenCalledWith('Zm9v');

    await conn.close();
  });

  it('pty_exit finalizes the active block and cancels stragglers', async () => {
    const rec = makeRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge();
    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData: () => {} });
    rec.setActive('blk-int' as BlockId);
    rec.setRunning(['blk-int' as BlockId, 'blk-ghost' as BlockId]);

    bridge.emit({
      kind: 'pty_exit',
      sessionId: conn.sessionId,
      exitCode: 0,
      signal: null,
    });

    expect(rec.completed).toEqual([{ id: 'blk-int', exitCode: 0 }]);
    expect(rec.canceled).toEqual(['blk-ghost']);
    await conn.close();
  });

  it('audit P1 (fix 2): pty_data after pty_exit does NOT dispatch to the active block', async () => {
    const rec = makeRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge();
    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData: () => {} });
    // Simulate a block still being the active one at the instant pty_exit
    // races a trailing pty_data. After fix 2, the late data must be dropped
    // BEFORE `appendToActiveBlock` even sees it.
    rec.setActive('blk-int' as BlockId);
    rec.setRunning(['blk-int' as BlockId]);

    bridge.emit({
      kind: 'pty_exit',
      sessionId: conn.sessionId,
      exitCode: 0,
      signal: null,
    });

    const appendsAfterExit = rec.appends.length;
    // Restore a plausibly-active block (mirroring the failure mode where a
    // new block was about to be started) so we'd otherwise see a stray
    // append land on it. The `ended` flag in connect must prevent this.
    rec.setActive('blk-next' as BlockId);

    bridge.emit({
      kind: 'pty_data',
      sessionId: conn.sessionId,
      seq: 99,
      bytesB64: 'dGFpbA==', // 'tail'
    });

    expect(rec.appends.length).toBe(appendsAfterExit);
    await conn.close();
  });

  it('disposes the router on conn.close so later routes are dropped', async () => {
    const rec = makeRecorder();
    unbind = bindBlockStore(rec.store);

    const bridge = makeBridge();
    const conn = await connectSession({ bridge, cols: 80, rows: 24, onData: () => {} });
    rec.setActive('blk-int' as BlockId);

    await conn.close();
    // Subscription is torn down, so emit has no listener. Even if some
    // external code held the bridge and called appendToActiveBlock
    // directly, the per-session router state is gone and no append would
    // fire — that is what we assert indirectly via rec.appends.
    bridge.emit({
      kind: 'pty_data',
      sessionId: conn.sessionId,
      seq: 2,
      bytesB64: 'YmFy',
    });
    expect(rec.appends).toHaveLength(0);
  });
});
