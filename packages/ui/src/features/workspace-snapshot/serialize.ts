/**
 * Pure capture / restore helpers for a WorkspaceSnapshot.
 *
 * The store layer (see store.ts) persists and orchestrates; this module is
 * stateless — it only reads from / writes into the live entity stores. That
 * split keeps the capture logic trivially unit-testable (feed stub stores, see
 * what comes out) and makes restore drop-in-replaceable from tests that want
 * to assert "the right createSession calls were made".
 */

import type { HostBridge } from '@quanta/host-common';
import {
  useSessionsStore,
  type SessionEntity,
} from '../../entities/session/index.js';
import {
  usePaneStore,
  type PaneNode,
} from '../../entities/pane/index.js';
import { useBlockFilterStore } from '../../entities/block-filter/index.js';
import { closeSession, createSession } from '../session-tabs/index.js';
import {
  AUTO_SNAPSHOT_ID,
  AUTO_SNAPSHOT_NAME,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  type SerializedPaneNode,
  type SnapSession,
  type WorkspaceSnapshot,
} from './model.js';
import type { SessionId } from '../../shared/types/generated/index.js';

// ─── Snapshot validation ──────────────────────────────────────────────────────

/** Maximum number of sessions allowed in a restored snapshot. */
export const MAX_SESSIONS = 64;

/** Maximum number of active tags allowed in a restored snapshot. */
const MAX_ACTIVE_TAGS = 100;

/** Maximum pane-tree nesting depth (prevents stack overflows on traversal). */
const MAX_PANE_TREE_DEPTH = 32;

/**
 * Validate that a pane tree does not exceed {@link MAX_PANE_TREE_DEPTH} levels
 * of nesting. Returns `true` when the depth is within the limit, `false` when
 * the tree is too deep.
 */
function maxPaneTreeDepth(node: unknown, limit: number = MAX_PANE_TREE_DEPTH): boolean {
  if (limit < 0) return false;
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n['kind'] === 'leaf') return true;
  if (n['kind'] === 'split') {
    return (
      maxPaneTreeDepth(n['left'], limit - 1) &&
      maxPaneTreeDepth(n['right'], limit - 1)
    );
  }
  // Unknown kind — treat as invalid
  return false;
}

/**
 * Validate raw (untrusted) IDB data before treating it as a
 * {@link WorkspaceSnapshot}. Returns the typed snapshot on success or `null`
 * when validation fails so the caller can skip the corrupt entry.
 */
export function validateSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const r = raw as Record<string, unknown>;

  // Version check
  if (r['version'] !== undefined) {
    // Top-level version field is not part of WorkspaceSnapshot — the version
    // lives in paneTree.version. Accept snapshots whose paneTree.version
    // matches WORKSPACE_SNAPSHOT_SCHEMA_VERSION.
  }

  // Required top-level fields
  if (typeof r['id'] !== 'string') return null;
  if (typeof r['name'] !== 'string') return null;
  if (typeof r['createdAt'] !== 'number') return null;
  if (typeof r['filterMode'] !== 'string') return null;

  // sessions array
  if (!Array.isArray(r['sessions'])) return null;
  if ((r['sessions'] as unknown[]).length > MAX_SESSIONS) return null;
  for (const s of r['sessions'] as unknown[]) {
    if (typeof s !== 'object' || s === null) return null;
    const session = s as Record<string, unknown>;
    if (typeof session['id'] !== 'string') return null;
    if (typeof session['shell'] !== 'string') return null;
    if (typeof session['cwd'] !== 'string') return null;
  }

  // activeTags array
  if (!Array.isArray(r['activeTags'])) return null;
  if ((r['activeTags'] as unknown[]).length > MAX_ACTIVE_TAGS) return null;

  // tabOrder array
  if (!Array.isArray(r['tabOrder'])) return null;

  // paneTree
  if (typeof r['paneTree'] !== 'object' || r['paneTree'] === null) return null;
  const pt = r['paneTree'] as Record<string, unknown>;
  if (pt['version'] !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) return null;
  if (!Array.isArray(pt['focusPath'])) return null;
  if (!maxPaneTreeDepth(pt['root'])) return null;

  return raw as WorkspaceSnapshot;
}

export interface CaptureSnapshotInput {
  /** Optional override — most callers omit this and let capture read from the
   *  real zustand stores. Tests pass stub snapshots of each. */
  readonly sessions?: { readonly order: readonly SessionId[]; readonly entities: Readonly<Record<SessionId, SessionEntity>> };
  readonly pane?: { readonly root: PaneNode | null; readonly focusPath: readonly number[]; readonly zoomedPaneId: SessionId | null };
  readonly filter?: { readonly activeTags: ReadonlySet<string>; readonly mode: 'any' | 'all' };
  /** Name to assign. Defaults to AUTO_SNAPSHOT_NAME if not supplied. */
  readonly name?: string;
  /** Explicit id to assign. Defaults to a new UUID; the auto-capture path
   *  passes AUTO_SNAPSHOT_ID so successive auto captures overwrite in place. */
  readonly id?: string;
  /** Optional timestamp override — tests set this for deterministic snapshots. */
  readonly createdAt?: number;
}

/**
 * Capture the current workspace layout into a plain-data snapshot. Does NOT
 * write to persistence; the store layer calls this and then persists the
 * returned value.
 */
export function captureSnapshot(input: CaptureSnapshotInput = {}): WorkspaceSnapshot {
  const sessions = input.sessions ?? {
    order: useSessionsStore.getState().order,
    entities: useSessionsStore.getState().entities,
  };
  const pane = input.pane ?? {
    root: usePaneStore.getState().root,
    focusPath: usePaneStore.getState().focusPath,
    zoomedPaneId: usePaneStore.getState().zoomedPaneId,
  };
  const filter = input.filter ?? {
    activeTags: useBlockFilterStore.getState().activeTags,
    mode: useBlockFilterStore.getState().mode,
  };

  const snapSessions: SnapSession[] = [];
  for (const id of sessions.order) {
    const entity = sessions.entities[id];
    if (!entity) continue;
    snapSessions.push({
      id: entity.id,
      shell: entity.shell,
      cwd: entity.cwd,
    });
  }

  const name = input.name ?? AUTO_SNAPSHOT_NAME;
  const id = input.id ?? (name === AUTO_SNAPSHOT_NAME ? AUTO_SNAPSHOT_ID : genId());
  const createdAt = input.createdAt ?? Date.now();

  return {
    id,
    name,
    createdAt,
    sessions: snapSessions,
    paneTree: {
      version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
      root: serializePaneNode(pane.root),
      focusPath: [...pane.focusPath],
      zoomedPaneId: pane.zoomedPaneId,
    },
    activeTags: [...filter.activeTags],
    filterMode: filter.mode,
    tabOrder: [...sessions.order],
  };
}

function serializePaneNode(node: PaneNode | null): SerializedPaneNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') {
    return { kind: 'leaf', sessionId: node.sessionId };
  }
  return {
    kind: 'split',
    dir: node.dir,
    ratio: node.ratio,
    left: serializePaneNode(node.left) as SerializedPaneNode,
    right: serializePaneNode(node.right) as SerializedPaneNode,
  };
}

/**
 * Deps surface for restoreSnapshot — exposed so tests can inject fakes for
 * createSession / closeSession without reaching through to a live bridge.
 */
export interface RestoreSnapshotDeps {
  readonly createSessionImpl?: typeof createSession;
  readonly closeSessionImpl?: typeof closeSession;
  readonly bridge?: HostBridge;
  /** Grid size passed to `createSession`. Defaults to 80x24 like TerminalPage. */
  readonly cols?: number;
  readonly rows?: number;
  /** onData callback threaded to createSession. Tests pass a no-op. */
  readonly onData?: (sessionId: SessionId, bytesB64: string) => void;
}

export interface RestoreSnapshotOptions extends RestoreSnapshotDeps {
  readonly snapshot: WorkspaceSnapshot;
}

/**
 * Restore a workspace snapshot. Tears down existing sessions first, then
 * respawns each one from its SnapSession metadata and replays the pane tree
 * + filter state onto the entity stores.
 *
 * Returns the map of {oldId -> newId} so callers (e.g. integration tests and
 * future UI hooks) can correlate the remapped ids. Pane tree / tab order in
 * the restored state carry the NEW ids — spawning a brand new PTY always
 * produces a fresh id, so we rewrite references as we go.
 */
export async function restoreSnapshot(
  options: RestoreSnapshotOptions,
): Promise<ReadonlyMap<SessionId, SessionId>> {
  const { snapshot } = options;
  const createImpl = options.createSessionImpl ?? createSession;
  const closeImpl = options.closeSessionImpl ?? closeSession;
  const bridge = options.bridge;
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const onData = options.onData ?? (() => {});

  // 1. Tear down every existing session (parallel close). We take a snapshot
  //    of the current order first — `closeSession` mutates the store and we
  //    don't want to iterate while it's shifting under us.
  const existingIds = [...useSessionsStore.getState().order];
  await Promise.all(existingIds.map((id) => closeImpl(id)));

  // 2. Respawn each snapshot session. We spawn sequentially so the tab
  //    order ends up deterministic (Promise.all can resolve in any order).
  //    createSession resolves with the real new SessionId.
  const idMap = new Map<SessionId, SessionId>();
  for (const snap of snapshot.sessions) {
    if (!bridge) {
      // No bridge → unit-test fast path: we still call createImpl but it
      // typically rejects without a bridge. The fake injected by tests
      // short-circuits this, so the code below stays linear.
    }
    const res = await createImpl({
      bridge: bridge as HostBridge,
      cols,
      rows,
      onData,
    });
    idMap.set(snap.id, res.sessionId);
  }

  // 3. Replay the pane tree with remapped ids. The pane store's actions
  //    expose `setRoot` + `splitActive` for building a tree interactively;
  //    for bulk restore we reach into the store's setState directly — the
  //    store's state is plain data and a one-shot rewrite is cheaper than
  //    replaying a sequence of splits that would each re-derive focus.
  const remappedTree = remapPaneNode(snapshot.paneTree.root, idMap);
  const remappedZoom =
    snapshot.paneTree.zoomedPaneId !== null
      ? idMap.get(snapshot.paneTree.zoomedPaneId) ?? null
      : null;
  usePaneStore.setState({
    root: remappedTree,
    focusPath: [...snapshot.paneTree.focusPath],
    zoomedPaneId: remappedZoom,
  });

  // 4. Restore the block-filter state. The filter doesn't depend on session
  //    ids, so no remap is needed — just drop the stored tags / mode in.
  useBlockFilterStore.setState({
    activeTags: new Set(snapshot.activeTags),
    mode: snapshot.filterMode,
  });

  // 5. Reorder tabs. addSession in createSession appends in spawn order; we
  //    may want a different final order if snapshot.tabOrder differs from
  //    snapshot.sessions iteration order (rare but possible when the user
  //    reordered tabs before save). Rebuild `order` on the store directly.
  const remappedOrder: SessionId[] = [];
  for (const oldId of snapshot.tabOrder) {
    const next = idMap.get(oldId);
    if (next) remappedOrder.push(next);
  }
  if (remappedOrder.length > 0) {
    useSessionsStore.setState((prev) => ({ ...prev, order: remappedOrder }));
  }

  return idMap;
}

function remapPaneNode(
  node: SerializedPaneNode | null,
  idMap: ReadonlyMap<SessionId, SessionId>,
): PaneNode | null {
  if (!node) return null;
  if (node.kind === 'leaf') {
    const next = idMap.get(node.sessionId);
    if (!next) return null;
    return { kind: 'leaf', sessionId: next };
  }
  const left = remapPaneNode(node.left, idMap);
  const right = remapPaneNode(node.right, idMap);
  // If either child failed to remap (its session wasn't in the snapshot),
  // the split collapses into the surviving child.
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return {
    kind: 'split',
    dir: node.dir,
    ratio: node.ratio,
    left,
    right,
  };
}

function genId(): string {
  const g = globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  };
  if (g.crypto?.randomUUID) return `snap_${g.crypto.randomUUID()}`;
  return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
