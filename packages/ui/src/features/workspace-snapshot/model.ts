/**
 * Workspace snapshot — layout-level state capture.
 *
 * Block persistence (see entities/block/persistence.ts) already handles
 * per-session block history. A workspace snapshot sits one layer above that:
 * it captures "what sessions are open, how are the panes laid out, what's the
 * active tag filter" so closing and reopening the app (or switching between
 * named workspace states) restores the full surface, not just the scrollback.
 *
 * Intentionally NOT included in a snapshot:
 *   - per-session block history (lives in its own IDB store, keyed by
 *     workspace+session — surviving restore is automatic);
 *   - theme / font / key bindings (global preferences are workspace-agnostic);
 *   - the crash marker / degraded-mode state (that is a distinct recovery
 *     path for ungraceful exits — snapshots are the graceful user-driven
 *     complement).
 *
 * Serialization format
 * --------------------
 * The serialized pane tree mirrors the `PaneNode` shape from
 * `entities/pane/model.ts` — a discriminated union of `leaf` / `split`. We
 * inline it here (rather than re-exporting `PaneNode`) so a future pane-tree
 * shape break can bump `SerializedPaneTree.version` without also bumping the
 * live in-memory type.
 */

import type { SessionId } from '../../shared/types/generated/index.js';
import type { FilterMode } from '../../entities/block-filter/index.js';

/** Discriminator for future schema bumps — read on rehydrate. */
export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1;

/** The reserved name for the auto-capture slot. Named snapshots MUST NOT use
 *  this value — the store enforces that in `saveSnapshot`. */
export const AUTO_SNAPSHOT_NAME = 'auto';

/** Fixed id used for the auto-capture row — reusing it means successive
 *  auto-captures overwrite in place rather than accumulating a tombstone
 *  train in IDB. Named snapshots get UUIDs. */
export const AUTO_SNAPSHOT_ID = 'snap_auto';

/**
 * Per-session metadata needed to respawn a session during restore. Deliberately
 * minimal — block history lives in the block store and arrives via its own
 * hydrate path.
 */
export interface SnapSession {
  readonly id: SessionId;
  readonly shell: string;
  readonly cwd: string;
  /** Optional reference to a named profile; falls back to the default when
   *  the id no longer exists at restore time. */
  readonly profileId?: string;
  /** Optional user-facing label — reserved for a future "rename tab" feature;
   *  restore currently ignores this but we persist it for forward-compat. */
  readonly label?: string;
}

/** Serialized pane-tree node. Kept structurally identical to PaneNode so the
 *  rehydration helper is a straight cast with a defensive validator. */
export type SerializedPaneNode =
  | { readonly kind: 'leaf'; readonly sessionId: SessionId }
  | {
      readonly kind: 'split';
      readonly dir: 'horizontal' | 'vertical';
      readonly ratio: number;
      readonly left: SerializedPaneNode;
      readonly right: SerializedPaneNode;
    };

export interface SerializedPaneTree {
  readonly version: number;
  readonly root: SerializedPaneNode | null;
  readonly focusPath: readonly number[];
  readonly zoomedPaneId: SessionId | null;
}

export interface WorkspaceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly sessions: readonly SnapSession[];
  readonly paneTree: SerializedPaneTree;
  readonly activeTags: readonly string[];
  readonly filterMode: FilterMode;
  readonly tabOrder: readonly SessionId[];
}

/** Is this snapshot the (single) automatic capture? Named snapshots return
 *  false. Used by the UI to separate the two groups and by the store to
 *  enforce the "auto does not overwrite named" rule. */
export function isAutoSnapshot(snap: WorkspaceSnapshot): boolean {
  return snap.id === AUTO_SNAPSHOT_ID || snap.name === AUTO_SNAPSHOT_NAME;
}
