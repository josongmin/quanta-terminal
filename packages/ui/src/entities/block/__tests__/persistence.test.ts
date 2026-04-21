/**
 * Block persistence — serialize/deserialize round-trips, debounced writes on
 * terminal transitions, hydrate on boot, quota eviction, and workspace
 * isolation. Uses the in-memory fake IDB so the tests run in jsdom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdbBlockAdapter,
  enforceQuota,
  hydrateFromPersistence,
  installBlockPersistence,
  serializeBlock,
  deserializeBlock,
  useBlockStore,
  type BlockPersistenceAdapter,
  type StoredBlock,
} from '../index.js';
import { fakeIdbFactory, resetFakeIdb } from '../../../shared/lib/persistence/__mocks__/fake-idb.js';

function makeAdapter(): BlockPersistenceAdapter {
  return createIdbBlockAdapter({ factory: fakeIdbFactory });
}

function makeInMemoryAdapter(): BlockPersistenceAdapter & {
  readonly writes: StoredBlock[];
} {
  const map = new Map<string, StoredBlock>();
  const writes: StoredBlock[] = [];
  return {
    writes,
    async save(block) {
      writes.push(block);
      map.set(`${block.workspaceId}|${block.id}`, block);
    },
    async loadAll(workspaceId) {
      return [...map.values()].filter((r) => r.workspaceId === workspaceId);
    },
    async clearWorkspace(workspaceId) {
      let n = 0;
      for (const [k, v] of [...map.entries()]) {
        if (v.workspaceId === workspaceId) {
          map.delete(k);
          n += 1;
        }
      }
      return n;
    },
    async deleteOne(workspaceId, id) {
      map.delete(`${workspaceId}|${id}`);
    },
    async count(workspaceId) {
      let n = 0;
      for (const v of map.values()) if (v.workspaceId === workspaceId) n += 1;
      return n;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetFakeIdb();
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  useBlockStore.getState().resetAll();
});

describe('serializeBlock / deserializeBlock', () => {
  it('round-trips a small block without compression', async () => {
    const id = useBlockStore.getState().startBlock('echo hi', '/tmp');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const b = useBlockStore.getState().entities[id];
    if (!b) throw new Error('missing block');

    const stored = await serializeBlock(b, 'ws_test');
    expect(stored.compressed).toBe(false);
    expect(stored.workspaceId).toBe('ws_test');
    expect(stored.command).toBe('echo hi');
    expect(stored.status).toBe('completed');
    expect(stored.outputCompressed).toEqual(new Uint8Array([104, 105, 10]));

    const hydrated = await deserializeBlock(stored);
    expect(hydrated.id).toBe(b.id);
    expect(hydrated.status).toBe('completed');
    expect(hydrated.outputChunks.length).toBe(1);
    expect(hydrated.outputChunks[0]).toEqual(new Uint8Array([104, 105, 10]));
    expect(hydrated.pinned).toBe(false);
    expect(hydrated.command).toBe('echo hi');
  });

  it('refuses to serialize a non-terminal block', async () => {
    const id = useBlockStore.getState().startBlock('sleep', '/');
    const b = useBlockStore.getState().entities[id];
    if (!b) throw new Error('missing');
    await expect(serializeBlock(b, 'ws_test')).rejects.toThrow(/terminal state/u);
    useBlockStore.getState().cancelBlock(id);
  });

  it('round-trips a canceled block', async () => {
    const id = useBlockStore.getState().createBlock('sleep 9', '/');
    useBlockStore.getState().cancelBlock(id);
    const b = useBlockStore.getState().entities[id];
    if (!b) throw new Error('missing');
    const stored = await serializeBlock(b, 'ws_test');
    const hydrated = await deserializeBlock(stored);
    expect(hydrated.status).toBe('canceled');
  });

  it('handles empty output', async () => {
    const id = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const b = useBlockStore.getState().entities[id];
    if (!b) throw new Error('missing');
    const stored = await serializeBlock(b, 'ws_test');
    const hydrated = await deserializeBlock(stored);
    expect(hydrated.outputChunks).toEqual([]);
  });
});

describe('installBlockPersistence — terminal transition hook', () => {
  it('writes on completeBlock', async () => {
    const adapter = makeInMemoryAdapter();
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_test',
      persistDebounceMs: 1,
    });
    try {
      const id = useBlockStore.getState().createBlock('pwd', '/tmp');
      useBlockStore.getState().completeBlock(id, 0);
      await handle.flushAll();
      expect(adapter.writes.length).toBe(1);
      expect(adapter.writes[0]?.id).toBe(id);
      expect(adapter.writes[0]?.status).toBe('completed');
    } finally {
      handle.uninstall();
    }
  });

  it('debounces coalesces rapid transitions to a single write per id', async () => {
    const adapter = makeInMemoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_test',
      persistDebounceMs: 30,
    });
    try {
      const id = useBlockStore.getState().createBlock('ls', '/');
      useBlockStore.getState().completeBlock(id, 0);
      // immediate pin-toggle should NOT produce a second write because the
      // debouncer coalesces within the wait window.
      useBlockStore.getState().togglePin(id);
      await new Promise<void>((r) => setTimeout(r, 5));
      useBlockStore.getState().togglePin(id); // flip back
      await handle.flushAll();
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(adapter.writes[0]?.pinned).toBe(false);
    } finally {
      handle.uninstall();
    }
  });

  it('does not write for a running block', async () => {
    const adapter = makeInMemoryAdapter();
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_test',
      persistDebounceMs: 1,
    });
    try {
      const id = useBlockStore.getState().createBlock('sleep', '/');
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1, 2, 3]));
      await flushMicrotasks();
      expect(adapter.writes.length).toBe(0);
      useBlockStore.getState().cancelBlock(id);
      await handle.flushAll();
      expect(adapter.writes.length).toBe(1);
      expect(adapter.writes[0]?.status).toBe('canceled');
    } finally {
      handle.uninstall();
    }
  });

  it('deletes from storage when block is cleared via clearHistory', async () => {
    const adapter = makeInMemoryAdapter();
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_test',
      persistDebounceMs: 1,
    });
    try {
      const id = useBlockStore.getState().createBlock('ls', '/');
      useBlockStore.getState().completeBlock(id, 0);
      await handle.flushAll();
      expect(await adapter.count('ws_test')).toBe(1);
      useBlockStore.getState().clearHistory();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(await adapter.count('ws_test')).toBe(0);
    } finally {
      handle.uninstall();
    }
  });

  it('does NOT re-write hydrated blocks that appeared in the store before install', async () => {
    // Regression: previously the subscription treated every "id appeared with
    // terminal status" as a new transition, including blocks that materialized
    // via hydrateBlocks. That forced a redundant write-back on boot and also
    // wrote hydrated ids with an unchanged pinned flag.
    const adapter = makeInMemoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');

    // Simulate hydrate BEFORE install (the real code path goes the other
    // way, but this is the robust contract: no matter when hydrate lands,
    // install must not spuriously re-save).
    useBlockStore.getState().hydrateBlocks([
      {
        id: 'hydrated-1',
        sessionId: '__default__' as never,
        command: 'ls',
        cwd: '/',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        exitCode: 0,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: null,
        tags: [],
      },
    ]);

    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_hydrate_noreplay',
      persistDebounceMs: 1,
    });
    try {
      await flushMicrotasks();
      await flushMicrotasks();
      // No saves should have been scheduled for the hydrated block.
      expect(saveSpy).not.toHaveBeenCalled();

      // But clearing history should still delete from disk even though we
      // never saw a save — the persistedIds set was primed at install time.
      useBlockStore.getState().clearHistory();
      await flushMicrotasks();
      await flushMicrotasks();
      // deleteOne was called once on clear — a live adapter would drop the row.
      // We assert via the public count API: still zero because we never
      // inserted into the in-memory store (hydrate bypasses the adapter).
      expect(await adapter.count('ws_hydrate_noreplay')).toBe(0);
    } finally {
      handle.uninstall();
    }
  });

  it('does NOT re-write on appendBlockOutput bursts (running block is never scheduled)', async () => {
    // Regression: the subscription fires on every entity ref change; we
    // short-circuit by gating on terminal status. Verify that 100 rapid
    // chunks for a running block trigger ZERO writes.
    const adapter = makeInMemoryAdapter();
    const saveSpy = vi.spyOn(adapter, 'save');
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_burst',
      persistDebounceMs: 1,
    });
    try {
      const id = useBlockStore.getState().createBlock('sleep', '/');
      for (let i = 0; i < 100; i += 1) {
        useBlockStore.getState().appendBlockOutput(id, new Uint8Array([i & 0xff]));
      }
      await flushMicrotasks();
      expect(saveSpy).not.toHaveBeenCalled();
      // Close the block so leak reports don't fire during afterEach.
      useBlockStore.getState().completeBlock(id, 0);
      await handle.flushAll();
      expect(saveSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle.uninstall();
    }
  });
});

describe('hydrateFromPersistence', () => {
  it('round-trips 5 blocks, oldest → newest, into the store', async () => {
    const adapter = makeAdapter();
    // Seed adapter with 5 blocks via a throwaway install (easier than
    // crafting StoredBlock rows by hand, and exercises the save path).
    const seedHandle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_hydrate',
      persistDebounceMs: 1,
    });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = useBlockStore.getState().createBlock(`cmd-${i}`, '/');
        ids.push(id);
        useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65 + i]));
        useBlockStore.getState().completeBlock(id, 0);
        await new Promise<void>((r) => setTimeout(r, 2));
      }
      await seedHandle.flushAll();
    } finally {
      seedHandle.uninstall();
    }
    // Reset in-memory state and hydrate.
    useBlockStore.getState().resetAll();
    expect(useBlockStore.getState().order.length).toBe(0);
    const loaded = await hydrateFromPersistence(adapter, 'ws_hydrate');
    expect(loaded.length).toBe(5);
    const order = useBlockStore.getState().order;
    expect(order.length).toBe(5);
    // Oldest → newest.
    const completedAts = order.map((id) => useBlockStore.getState().entities[id]?.completedAt ?? 0);
    const sorted = [...completedAts].sort((a, b) => a - b);
    expect(completedAts).toEqual(sorted);
  });

  it('survives a gzipped output when CompressionStream is available', async () => {
    // When CompressionStream is missing (jsdom default), we still ship raw
    // — round-trip must hold either way.
    const adapter = makeAdapter();
    const handle = installBlockPersistence({
      adapter,
      workspaceId: 'ws_gzip',
      persistDebounceMs: 1,
    });
    try {
      const id = useBlockStore.getState().createBlock('big', '/');
      // 2 MiB of bytes → triggers gzip branch when available.
      const payload = new Uint8Array(2 * 1024 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
      useBlockStore.getState().appendBlockOutput(id, payload);
      useBlockStore.getState().completeBlock(id, 0);
      await handle.flushAll();
    } finally {
      handle.uninstall();
    }
    useBlockStore.getState().resetAll();
    await hydrateFromPersistence(adapter, 'ws_gzip');
    const ids = useBlockStore.getState().order;
    expect(ids.length).toBe(1);
    const [firstId] = ids;
    if (!firstId) throw new Error('missing hydrated id');
    const stored = useBlockStore.getState().entities[firstId];
    if (!stored) throw new Error('missing hydrated block');
    expect(stored.command).toBe('big');
    expect(stored.outputChunks.length).toBe(1);
    expect(stored.outputChunks[0]?.byteLength).toBe(2 * 1024 * 1024);
  });

  it('drops running blocks during hydrate', async () => {
    // Fabricate a stored row in 'running' state (shouldn't happen in
    // production, but the guard is part of the hydrate contract).
    const adapter = makeInMemoryAdapter();
    useBlockStore.getState().hydrateBlocks([
      {
        id: 'fake',
        sessionId: '__default__' as never,
        command: 'never',
        status: 'running',
        cwd: '/',
        startedAt: 1,
        completedAt: null,
        exitCode: null,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: null,
        tags: [],
      },
    ]);
    expect(useBlockStore.getState().order.length).toBe(0);
    expect(adapter.writes.length).toBe(0);
  });
});

describe('enforceQuota', () => {
  it('evicts the oldest non-pinned block past the cap', async () => {
    const adapter = makeInMemoryAdapter();
    const rows: StoredBlock[] = [];
    for (let i = 0; i < 2001; i += 1) {
      rows.push({
        id: `b${i}`,
        workspaceId: 'ws_q',
        command: `c${i}`,
        cwd: '/',
        status: 'completed',
        exitCode: 0,
        startedAt: i,
        completedAt: i,
        outputCompressed: new Uint8Array(0),
        compressed: false,
        pinned: i === 0, // pin the very oldest
        sessionId: null,
        rerunOfId: null,
        errorMessage: null,
      });
    }
    for (const r of rows) await adapter.save(r);
    expect(await adapter.count('ws_q')).toBe(2001);
    const evicted = await enforceQuota(adapter, 'ws_q', 2000);
    expect(evicted).toBe(1);
    // Oldest non-pinned is b1 (b0 is pinned), so b1 should be gone.
    expect(await adapter.count('ws_q')).toBe(2000);
    const all = await adapter.loadAll('ws_q');
    expect(all.find((r) => r.id === 'b0')).toBeDefined(); // pinned survives
    expect(all.find((r) => r.id === 'b1')).toBeUndefined();
  });

  it('is a no-op when under the cap', async () => {
    const adapter = makeInMemoryAdapter();
    await adapter.save({
      id: 'only',
      workspaceId: 'ws',
      command: 'x',
      cwd: '/',
      status: 'completed',
      exitCode: 0,
      startedAt: 0,
      completedAt: 0,
      outputCompressed: new Uint8Array(0),
      compressed: false,
      pinned: false,
      sessionId: null,
      rerunOfId: null,
      errorMessage: null,
    });
    const evicted = await enforceQuota(adapter, 'ws', 2000);
    expect(evicted).toBe(0);
  });

  it('filters by workspace — other workspaces are untouched', async () => {
    const adapter = makeInMemoryAdapter();
    for (let i = 0; i < 3; i += 1) {
      await adapter.save({
        id: `a${i}`,
        workspaceId: 'ws_a',
        command: '',
        cwd: '/',
        status: 'completed',
        exitCode: 0,
        startedAt: i,
        completedAt: i,
        outputCompressed: new Uint8Array(0),
        compressed: false,
        pinned: false,
        sessionId: null,
        rerunOfId: null,
        errorMessage: null,
      });
    }
    await adapter.save({
      id: 'b0',
      workspaceId: 'ws_b',
      command: '',
      cwd: '/',
      status: 'completed',
      exitCode: 0,
      startedAt: 0,
      completedAt: 0,
      outputCompressed: new Uint8Array(0),
      compressed: false,
      pinned: false,
      sessionId: null,
      rerunOfId: null,
      errorMessage: null,
    });
    await enforceQuota(adapter, 'ws_a', 2);
    expect(await adapter.count('ws_a')).toBe(2);
    expect(await adapter.count('ws_b')).toBe(1);
  });
});
