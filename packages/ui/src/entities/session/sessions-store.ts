/**
 * Multi-session store — the collection of known sessions.
 *
 * Phase 4 adds multi-session support. The legacy `useSessionStore` (singular)
 * kept one `SessionState` slice and was updated imperatively by the connect
 * feature. We preserve its shape so existing call sites keep compiling, but
 * its fields are now a read-through view over the ACTIVE entity in this
 * collection.
 *
 * Shape
 * -----
 * Normalized: `order` is the visual left-to-right tab order, `entities` maps
 * id → SessionEntity, and `activeId` is the currently focused session.
 * Keeping them separate lets us add/remove/switch without rebuilding arrays.
 *
 * The entity shape is a structural SUPERSET of the legacy SessionState —
 * every field the singular store exposed lives here, typed identically, so
 * the mirror (see `model.ts`) is a straight fan-out. Future additions should
 * extend this first, then be projected into the mirror.
 *
 * Not persisted. Per-process, per-launch. A localStorage leak would produce
 * ghost sessions on next boot with dangling ids. The singular store already
 * enforces this invariant via `edge-persistence.test.ts`; the collection
 * follows the same rule.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  CwdSource,
  SessionId,
  ShellIntegrationStatus,
} from '../../shared/types/generated/index.js';
import type { SessionHealth } from './model.js';

export interface SessionEntity {
  readonly id: SessionId;
  readonly shell: string;
  readonly cwd: string;
  readonly cwdSource: CwdSource;
  readonly shellIntegration: ShellIntegrationStatus;
  readonly health: SessionHealth;
  readonly exitCode: number | null;
}

export interface SessionEntitySeed {
  readonly id: SessionId;
  readonly shell?: string;
  readonly cwd?: string;
  readonly cwdSource?: CwdSource;
  readonly shellIntegration?: ShellIntegrationStatus;
  readonly health?: SessionHealth;
  readonly exitCode?: number | null;
}

export interface SessionsState {
  readonly order: readonly SessionId[];
  readonly entities: Readonly<Record<SessionId, SessionEntity>>;
  readonly activeId: SessionId | null;
}

export interface SessionsActions {
  /** Add a session, append to tab order. If first, becomes active automatically. */
  addSession(seed: SessionEntitySeed): void;
  /**
   * Remove a session and pick a neighbor as the new active (right sibling first,
   * then left, then null). Idempotent for unknown ids.
   */
  removeSession(id: SessionId): void;
  /** Make an existing session the active one. No-op for unknown ids. */
  setActive(id: SessionId): void;
  /**
   * Patch fields on a specific session. Creates a new entity object each call
   * so `useShallow` consumers re-render only when fields they read change.
   */
  patchSession(id: SessionId, patch: Partial<SessionEntity>): void;
  /**
   * Terminal transition: mark session exited with a code. If session is
   * unknown, the call is a no-op (tab may have been closed before the
   * pty_exit event arrived).
   */
  markExited(id: SessionId, exitCode: number | null): void;
  /** Test helper — wipe everything. */
  reset(): void;
}

const DEFAULT_ENTITY_DEFAULTS: Omit<SessionEntity, 'id'> = {
  shell: '',
  cwd: '',
  cwdSource: 'launch',
  shellIntegration: 'missing',
  health: 'booting',
  exitCode: null,
};

const INITIAL: SessionsState = {
  order: [],
  entities: {},
  activeId: null,
};

/**
 * Audit P1 (fix 3): port for "session was just removed" so cross-slice cleanup
 * can run without this entity module importing other slices. The block entity
 * adapter registers a callback that clears `activeBlockId` when it belongs to
 * the removed session.
 *
 * Keeping this as a nullable port mirrors the pattern used by
 * `setRouterBlockSessionLookup` in `features/command/route-output.ts`: the
 * session store is entities-layer and must not depend on feature or other
 * entity modules; the concrete wiring lives in the adapter.
 *
 * Unbound → no-op. An unhandled orphan pointer is still better than a crash
 * during early boot / tests that don't install the hook.
 */
type SessionRemovalHook = (id: SessionId) => void;
let onRemoveSessionCallback: SessionRemovalHook | null = null;

export function bindSessionRemovalHook(cb: SessionRemovalHook): () => void {
  const prev = onRemoveSessionCallback;
  onRemoveSessionCallback = cb;
  return () => {
    onRemoveSessionCallback = prev;
  };
}

/** Test-only: peek at whether the hook is bound. */
export function __getSessionRemovalHookForTests(): SessionRemovalHook | null {
  return onRemoveSessionCallback;
}

export const useSessionsStore = create<SessionsState & SessionsActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL,

    addSession: (seed) =>
      set((prev) => {
        if (prev.entities[seed.id]) return prev;
        const entity: SessionEntity = {
          ...DEFAULT_ENTITY_DEFAULTS,
          ...stripUndefined(seed),
          id: seed.id,
        };
        return {
          order: [...prev.order, seed.id],
          entities: { ...prev.entities, [seed.id]: entity },
          activeId: prev.activeId ?? seed.id,
        };
      }),

    removeSession: (id) => {
      let removed = false;
      set((prev) => {
        if (!prev.entities[id]) return prev;
        removed = true;
        const idx = prev.order.indexOf(id);
        const nextOrder = idx < 0 ? prev.order : prev.order.filter((x) => x !== id);
        const nextEntities = { ...prev.entities };
        delete nextEntities[id];
        let nextActive: SessionId | null = prev.activeId;
        if (prev.activeId === id) {
          // Prefer the tab to the right (same index in the new order), then fall
          // back to the left neighbor, else null. This matches the muscle memory
          // of browser tab UIs — closing a tab keeps focus on the next one.
          if (idx >= 0 && idx < nextOrder.length) {
            nextActive = nextOrder[idx] ?? null;
          } else if (nextOrder.length > 0) {
            nextActive = nextOrder[nextOrder.length - 1] ?? null;
          } else {
            nextActive = null;
          }
        }
        return { order: nextOrder, entities: nextEntities, activeId: nextActive };
      });
      // Audit P1 (fix 3): notify the block-side cleanup AFTER the session
      // state transition commits, so any listener that re-reads the sessions
      // store sees it already gone. Unbound → no-op; tests exercise both.
      if (removed && onRemoveSessionCallback) {
        onRemoveSessionCallback(id);
      }
    },

    setActive: (id) =>
      set((prev) => {
        if (!prev.entities[id]) return prev;
        if (prev.activeId === id) return prev;
        return { ...prev, activeId: id };
      }),

    patchSession: (id, patch) =>
      set((prev) => {
        const existing = prev.entities[id];
        if (!existing) return prev;
        const nextEntity: SessionEntity = { ...existing, ...stripUndefined(patch), id };
        return {
          ...prev,
          entities: { ...prev.entities, [id]: nextEntity },
        };
      }),

    markExited: (id, exitCode) =>
      set((prev) => {
        const existing = prev.entities[id];
        if (!existing) return prev;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...existing, health: 'exited', exitCode },
          },
        };
      }),

    reset: () => set(() => ({ ...INITIAL })),
  })),
);

/**
 * Strip `undefined` fields from a partial so a `{ shell: undefined }` in a
 * patch does not clobber the existing `shell` with `undefined`. Zustand's
 * set-merge is shallow and would otherwise replace truthy fields.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as Array<[keyof T, T[keyof T]]>) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Convenience: the active entity (or `undefined` when no session exists). */
export function getActiveSessionEntity(): SessionEntity | undefined {
  const s = useSessionsStore.getState();
  return s.activeId === null ? undefined : s.entities[s.activeId];
}
