/**
 * Session entity (singular, active-mirror) — backwards-compat hook over the
 * multi-session collection.
 *
 * Phase 1–3 had a single implicit session. Phase 4 adds N sessions in
 * `sessions-store.ts`. To keep all existing call sites compiling, the
 * singular `useSessionStore` is now a thin MIRROR of the active entity
 * in the collection store:
 *
 *   - Read path: subscribes to `useSessionsStore` and projects the active
 *     entity's fields into the same `SessionState` shape the store used to
 *     expose directly. If no session is active, fields fall back to the
 *     original INITIAL defaults (`id: null, health: 'booting', ...`).
 *   - Write path: every action here delegates to the collection store,
 *     targeting the active session id (or no-op when none is active). This
 *     preserves the surface `setSession/markExited/reset` that today's code
 *     calls in many places.
 *
 * Why a mirror store instead of a selector hook? Historical call sites reach
 * in via `useSessionStore.getState().setSession({...})`, which needs a real
 * zustand store handle. Rewriting every call site to the new collection
 * surface was explicitly out of scope for Phase 4 (see `backwards-compat`
 * in the Phase 4 brief). The mirror keeps that surface intact.
 *
 * Shape identity
 * --------------
 * `SessionState` / `SessionActions` / `SessionHealth` exports are preserved
 * byte-compatible with the Phase-3 versions so consumers (selectors,
 * widgets, tests) need zero changes.
 *
 * Persistence
 * -----------
 * Neither this mirror nor the underlying collection writes to any Storage.
 * The `edge-persistence.test.ts` suite continues to pass by inspection —
 * `setSession/markExited/reset` still touch no storage APIs because their
 * implementations now funnel into the collection store's in-memory map.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  CwdSource,
  SessionId,
  ShellIntegrationStatus,
} from '../../shared/types/generated/index.js';
import { useSessionsStore, type SessionEntity } from './sessions-store.js';

export type SessionHealth = 'booting' | 'ready' | 'exited' | 'error';

export interface SessionState {
  readonly id: SessionId | null;
  readonly shell: string;
  readonly cwd: string;
  readonly cwdSource: CwdSource;
  readonly shellIntegration: ShellIntegrationStatus;
  readonly health: SessionHealth;
  readonly exitCode: number | null;
}

export interface SessionActions {
  setSession(patch: Partial<SessionState>): void;
  markExited(exitCode: number | null): void;
  reset(): void;
}

const INITIAL: SessionState = {
  id: null,
  shell: '',
  cwd: '',
  cwdSource: 'launch',
  shellIntegration: 'missing',
  health: 'booting',
  exitCode: null,
};

function project(entity: SessionEntity | undefined): SessionState {
  if (!entity) return INITIAL;
  return {
    id: entity.id,
    shell: entity.shell,
    cwd: entity.cwd,
    cwdSource: entity.cwdSource,
    shellIntegration: entity.shellIntegration,
    health: entity.health,
    exitCode: entity.exitCode,
  };
}

/**
 * Internal: apply a patch originating from the legacy `setSession(patch)` API
 * to the collection. The legacy API could both "seed a new active session"
 * and "mutate the current one" — it keyed by `.id` in the patch when present,
 * otherwise by the current active id. We preserve both semantics here.
 */
/**
 * Returns `true` when the patch should also be applied to the collection,
 * `false` when it is a pre-boot mirror-only write.
 */
function applyLegacyPatch(patch: Partial<SessionState>): boolean {
  const coll = useSessionsStore.getState();
  const patchId = patch.id;
  if (patchId !== undefined && patchId !== null) {
    const { id: _omit, ...rest } = patch;
    if (!coll.entities[patchId]) {
      coll.addSession({ id: patchId, ...rest });
    } else {
      coll.patchSession(patchId, rest);
    }
    if (coll.activeId !== patchId) coll.setActive(patchId);
    return true;
  }
  const activeId = coll.activeId;
  if (activeId === null) {
    // Pre-boot mirror-only write. Historical callers issued `setSession`
    // with no id to flip e.g. `health: 'error'` while the first spawn was
    // still pending. The mirror holds those fields locally until a
    // collection entity appears; when one does, the collection becomes the
    // source of truth and a subsequent patch subscription will overwrite.
    return false;
  }
  const { id: _omit, ...rest } = patch;
  coll.patchSession(activeId, rest);
  return true;
}

/**
 * Mirror store. Its state is rebuilt from the collection on every collection
 * change via a subscription below. Widgets continue calling
 * `useSessionStore(s => s.shell)` etc., unchanged from Phase 3.
 */
export const useSessionStore = create<SessionState & SessionActions>()(
  subscribeWithSelector((set) => ({
    ...project(
      // Initial paint: project whatever the collection happens to have now.
      useSessionsStore.getState().activeId !== null
        ? useSessionsStore.getState().entities[
            useSessionsStore.getState().activeId as SessionId
          ]
        : undefined,
    ),
    setSession: (patch) => {
      const wentToCollection = applyLegacyPatch(patch);
      if (wentToCollection) {
        // Defensive synchronous pre-seed so `.getState()` reads right after
        // `setSession` see the new values even if React hasn't flushed.
        // The collection → mirror subscription will also update asynchronously.
        const snap = useSessionsStore.getState();
        set(() => project(snap.activeId === null ? undefined : snap.entities[snap.activeId]));
      } else {
        // Pre-boot: patch the mirror directly so tests and bootstrap code
        // that set `health`/`exitCode` without an id still reflect in the
        // singular store.
        set((prev) => ({ ...prev, ...patch }));
      }
    },
    markExited: (exitCode) => {
      const coll = useSessionsStore.getState();
      const activeId = coll.activeId;
      if (activeId !== null) {
        coll.markExited(activeId, exitCode);
        const snap = useSessionsStore.getState();
        set(() => project(snap.activeId === null ? undefined : snap.entities[snap.activeId]));
      } else {
        // Pre-boot terminal transition (the first spawn rejected, no
        // collection entity ever existed). Update the mirror directly.
        set(() => ({ health: 'exited', exitCode }));
      }
    },
    reset: () => {
      useSessionsStore.getState().reset();
      set(() => ({ ...INITIAL }));
    },
  })),
);

// Keep the mirror in sync on EVERY collection change — additions, removals,
// switches, field patches. One subscription services all mutations; widgets
// that only read `useSessionStore` continue to get reactive updates without
// knowing the collection exists.
useSessionsStore.subscribe(
  (s) => {
    const id = s.activeId;
    if (id === null) return undefined;
    return s.entities[id];
  },
  (entity) => {
    useSessionStore.setState(project(entity));
  },
);
