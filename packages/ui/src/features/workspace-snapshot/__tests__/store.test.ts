/**
 * Store / adapter / auto-capture integration tests.
 *
 * We swap in the fake IDB factory and an in-memory-adapter shim so the tests
 * can exercise the persistence round-trip, auto-capture on visibilitychange,
 * and autoRestoreIfPresent wiring without a real browser or real IDB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWorkspaceSnapshotStore,
  setSnapshotAdapter,
  saveNamedSnapshot,
  saveAutoSnapshot,
  autoRestoreIfPresent,
  bindAutoCapture,
  createIdbSnapshotAdapter,
  AUTO_SNAPSHOT_ID,
  AUTO_SNAPSHOT_NAME,
  splitSnapshots,
  type WorkspaceSnapshot,
  type SnapshotAdapter,
} from '../index.js';
import { captureSnapshot, restoreSnapshot } from '../serialize.js';
import { useSessionsStore } from '../../../entities/session/index.js';
import { usePaneStore } from '../../../entities/pane/index.js';
import { useBlockFilterStore } from '../../../entities/block-filter/index.js';
import { fakeIdbFactory, resetFakeIdb } from '../../../shared/lib/persistence/__mocks__/fake-idb.js';
import type { SessionId } from '../../../shared/types/generated/index.js';
import type { CreateSessionResult } from '../../session-tabs/index.js';

function makeInMemoryAdapter(): SnapshotAdapter & { readonly writes: WorkspaceSnapshot[] } {
  const map = new Map<string, WorkspaceSnapshot>();
  const writes: WorkspaceSnapshot[] = [];
  return {
    writes,
    async save(snap) {
      writes.push(snap);
      map.set(snap.id, snap);
    },
    async loadAll() {
      return [...map.values()];
    },
    async deleteOne(id) {
      map.delete(id);
    },
  };
}

beforeEach(() => {
  resetFakeIdb();
  useWorkspaceSnapshotStore.getState().reset();
  useSessionsStore.getState().reset();
  usePaneStore.getState().reset();
  useBlockFilterStore.getState().clear();
});

afterEach(() => {
  setSnapshotAdapter(null);
});

describe('store save/delete + hydrate', () => {
  it('saveSnapshot writes through adapter and mirrors in-memory', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    const snap = captureSnapshot({ name: 'named one', createdAt: 1 });
    await useWorkspaceSnapshotStore.getState().saveSnapshot(snap);
    expect(adapter.writes).toHaveLength(1);
    expect(useWorkspaceSnapshotStore.getState().snapshots).toHaveLength(1);
  });

  it('saveSnapshot replaces-by-id, so auto slot overwrites in place', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    await useWorkspaceSnapshotStore.getState().saveSnapshot(
      captureSnapshot({ name: AUTO_SNAPSHOT_NAME, id: AUTO_SNAPSHOT_ID, createdAt: 1 }),
    );
    await useWorkspaceSnapshotStore.getState().saveSnapshot(
      captureSnapshot({ name: AUTO_SNAPSHOT_NAME, id: AUTO_SNAPSHOT_ID, createdAt: 2 }),
    );
    const snaps = useWorkspaceSnapshotStore.getState().snapshots;
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.createdAt).toBe(2);
  });

  it('hydrate loads snapshots newest-last and sets hydrated=true', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    await adapter.save(captureSnapshot({ name: 'b', id: 'id-b', createdAt: 20 }));
    await adapter.save(captureSnapshot({ name: 'a', id: 'id-a', createdAt: 10 }));
    await useWorkspaceSnapshotStore.getState().hydrate();
    const s = useWorkspaceSnapshotStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.snapshots.map((x) => x.id)).toEqual(['id-a', 'id-b']);
  });

  it('saveSnapshot updates in-memory store synchronously before IDB write completes', async () => {
    // Use an adapter whose save() never resolves, simulating a slow IDB write.
    let resolveSave!: () => void;
    const slowAdapter: SnapshotAdapter = {
      async save(_snap) {
        await new Promise<void>((resolve) => { resolveSave = resolve; });
      },
      async loadAll() { return []; },
      async deleteOne(_id) {},
    };
    setSnapshotAdapter(slowAdapter);
    const snap = captureSnapshot({ name: 'fast-check', createdAt: 99 });
    // Start saveSnapshot but do NOT await it yet — IDB write is pending.
    const savePromise = useWorkspaceSnapshotStore.getState().saveSnapshot(snap);
    // The in-memory store must already contain the snapshot at this point.
    expect(useWorkspaceSnapshotStore.getState().snapshots).toHaveLength(1);
    expect(useWorkspaceSnapshotStore.getState().snapshots[0]?.name).toBe('fast-check');
    // Unblock the IDB write and await completion.
    resolveSave();
    await savePromise;
  });

  it('saveNamedSnapshot rejects the reserved "auto" name', async () => {
    setSnapshotAdapter(makeInMemoryAdapter());
    await expect(saveNamedSnapshot('auto')).rejects.toThrow(/reserved/u);
  });

  it('saveNamedSnapshot rejects empty names', async () => {
    setSnapshotAdapter(makeInMemoryAdapter());
    await expect(saveNamedSnapshot('   ')).rejects.toThrow(/empty/u);
  });

  it('deleteSnapshot removes from store + adapter', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    const s = captureSnapshot({ name: 'x', createdAt: 0 });
    await useWorkspaceSnapshotStore.getState().saveSnapshot(s);
    await useWorkspaceSnapshotStore.getState().deleteSnapshot(s.id);
    expect(useWorkspaceSnapshotStore.getState().snapshots).toHaveLength(0);
    const loaded = await adapter.loadAll();
    expect(loaded).toHaveLength(0);
  });
});

describe('IDB adapter round-trip', () => {
  it('save + loadAll via the fake IDB factory yields identical rows', async () => {
    const adapter = createIdbSnapshotAdapter({ factory: fakeIdbFactory });
    const snap: WorkspaceSnapshot = {
      id: 'snap_round_trip',
      name: 'trip',
      createdAt: 42,
      sessions: [{ id: 'a' as SessionId, shell: '/bin/zsh', cwd: '/tmp' }],
      paneTree: {
        version: 1,
        root: { kind: 'leaf', sessionId: 'a' as SessionId },
        focusPath: [],
        zoomedPaneId: null,
      },
      activeTags: ['tag-a', 'tag-b'],
      filterMode: 'all',
      tabOrder: ['a' as SessionId],
    };
    await adapter.save(snap);
    const rows = await adapter.loadAll();
    expect(rows).toHaveLength(1);
    const row = rows[0] as WorkspaceSnapshot;
    expect(row.id).toBe(snap.id);
    expect(row.name).toBe(snap.name);
    expect(row.sessions).toEqual(snap.sessions);
    expect(row.paneTree.root).toEqual(snap.paneTree.root);
    expect(row.activeTags).toEqual(snap.activeTags);
    expect(row.filterMode).toBe('all');
  });
});

describe('auto-capture lifecycle', () => {
  it('saveAutoSnapshot stamps the reserved id + name', async () => {
    setSnapshotAdapter(makeInMemoryAdapter());
    const snap = await saveAutoSnapshot();
    expect(snap.id).toBe(AUTO_SNAPSHOT_ID);
    expect(snap.name).toBe(AUTO_SNAPSHOT_NAME);
  });

  it('visibilitychange -> hidden fires an auto capture', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    const binding = bindAutoCapture();
    try {
      // Simulate the document going hidden.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      // The handler is fire-and-forget; spin the microtask queue.
      await new Promise((r) => setTimeout(r, 0));
      // Exactly 1 auto-capture must fire — not 0, not 10.
      expect(adapter.writes).toHaveLength(1);
      const saved = adapter.writes[0]!;
      expect(saved.id).toBe(AUTO_SNAPSHOT_ID);
      expect(saved.name).toBe(AUTO_SNAPSHOT_NAME);
      // The snapshot must carry a valid (non-null) sessions array.
      expect(Array.isArray(saved.sessions)).toBe(true);
    } finally {
      binding.uninstall();
    }
  });
});

describe('autoRestoreIfPresent', () => {
  it('returns false when autoRestore is off', async () => {
    setSnapshotAdapter(makeInMemoryAdapter());
    useWorkspaceSnapshotStore.getState().setAutoRestore(false);
    const ok = await autoRestoreIfPresent();
    expect(ok).toBe(false);
  });

  it('returns false when no auto snapshot exists', async () => {
    setSnapshotAdapter(makeInMemoryAdapter());
    useWorkspaceSnapshotStore.getState().setAutoRestore(true);
    const ok = await autoRestoreIfPresent();
    expect(ok).toBe(false);
  });

  it('restores the auto snapshot when present', async () => {
    const adapter = makeInMemoryAdapter();
    setSnapshotAdapter(adapter);
    useWorkspaceSnapshotStore.getState().setAutoRestore(true);

    // Seed a session + capture the auto snapshot.
    useSessionsStore.getState().addSession({ id: 'old-x' as SessionId });
    usePaneStore.getState().setRoot('old-x' as SessionId);
    useBlockFilterStore.getState().addTag('debug');
    await saveAutoSnapshot();

    const createImpl = vi.fn(async (): Promise<CreateSessionResult> => {
      useSessionsStore.getState().addSession({ id: 'new-x' as SessionId });
      return { sessionId: 'new-x' as SessionId, connection: {} as never };
    });
    const closeImpl = vi.fn(async (id: SessionId) => {
      useSessionsStore.getState().removeSession(id);
    });

    // Inject deps: autoRestoreIfPresent forwards them to restoreSnapshot.
    const ok = await autoRestoreIfPresent({
      createSessionImpl: createImpl,
      closeSessionImpl: closeImpl,
    });
    expect(ok).toBe(true);
    expect(closeImpl).toHaveBeenCalledWith('old-x');
    expect(createImpl).toHaveBeenCalledTimes(1);
    expect(useBlockFilterStore.getState().activeTags.has('debug')).toBe(true);
  });
});

describe('splitSnapshots helper', () => {
  it('separates the auto slot from named snapshots', () => {
    const auto: WorkspaceSnapshot = {
      id: AUTO_SNAPSHOT_ID,
      name: AUTO_SNAPSHOT_NAME,
      createdAt: 1,
      sessions: [],
      paneTree: { version: 1, root: null, focusPath: [], zoomedPaneId: null },
      activeTags: [],
      filterMode: 'any',
      tabOrder: [],
    };
    const named1: WorkspaceSnapshot = { ...auto, id: 'n1', name: 'deploy', createdAt: 10 };
    const named2: WorkspaceSnapshot = { ...auto, id: 'n2', name: 'debug', createdAt: 20 };
    const split = splitSnapshots([auto, named1, named2]);
    expect(split.auto).toBe(auto);
    // Newest-first ordering.
    expect(split.named.map((s) => s.id)).toEqual(['n2', 'n1']);
  });
});

// Silence the restoreSnapshot import warning — we only use it transitively
// through autoRestoreIfPresent, but importing it here ensures the module
// graph stays warm in test isolation.
void restoreSnapshot;
