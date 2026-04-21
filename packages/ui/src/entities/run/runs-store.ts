/**
 * Run store — zustand-backed collection for Plan 0005 P2-A.
 *
 * Normalized shape, mirroring the Block store. `runs` is the id → entity
 * map; `order` is the insertion order (top-level + subruns interleaved —
 * the DAG is encoded in `parentRunId`, not the order array); `activeRunId`
 * is the Run the adapter currently considers "in-flight and accepting
 * output events".
 *
 * Actions
 * -------
 * - `startRun(init)` creates and returns a new `pending` Run and makes it
 *   active. Why not auto-`running`? The adapter has use cases where a Run
 *   is allocated before the boundary detector confirms command start
 *   (agent tool-calls queue before the model commits to running them); the
 *   two-phase start lets the caller use the returned id immediately. Call
 *   `updateRun(id, { state: 'running' })` or use `completeRun` on the same
 *   tick when the adapter doesn't need the pending intermediate.
 * - `updateRun(id, patch)` merges non-lifecycle-sensitive fields. Terminal
 *   runs reject the patch (see `isTerminalRunState`). Setting `state` via
 *   this action is allowed but callers should prefer `completeRun` /
 *   `cancelRun` for terminal transitions because those set the auxiliary
 *   fields (`completedAt`, `exitCode`, `signal`) atomically.
 * - `completeRun(id, exit, signal?)` flips a non-terminal Run to
 *   `completed` with the given exit code, stamps `completedAt`, and clears
 *   `activeRunId` if it was pointing at this Run. No-op on terminal runs.
 * - `cancelRun(id, reason?)` flips a non-terminal Run to `canceled` and
 *   stashes the reason in metadata.cancelReason. Same `activeRunId` clear.
 * - `setActive(id)` sets the active pointer. Accepts `null` to clear.
 * - `getChildren(parentId)` returns all runs whose `parentRunId === parentId`
 *   in insertion order — used by subrun DAG walks.
 * - `reset()` wipes the store. Test helper; also valid when the app is
 *   shutting a workspace.
 *
 * This store is intentionally NOT persisted. Runs are session-scoped today;
 * any future durability story (e.g. agent trace archive) ships as a
 * separate adapter, not by piggy-backing on this module.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SessionId } from '../../shared/types/generated/index.js';
import {
  DEFAULT_RUN_CONFIDENCE,
  DEFAULT_RUN_OUTPUT_TYPE,
  isTerminalRunState,
  type OutputType,
  type ResourceUsage,
  type Run,
  type RunId,
  type RunState,
  type RunType,
  type SemanticRange,
} from './model.js';

/**
 * Init payload for `startRun`. Only `sessionId` and `type` are required —
 * the rest default to sensible placeholders:
 *   - `command` defaults to `null` (non-shell runs often have no command)
 *   - `cwd` defaults to the empty string (caller should pass the owning
 *     session's cwd when available)
 *   - `parentRunId` defaults to `null` (top-level Run)
 *   - `metadata` defaults to `{}`
 *
 * The returned id is safe to use immediately — the store is synchronous.
 */
export interface StartRunInit {
  readonly sessionId: SessionId;
  readonly type: RunType;
  readonly command?: string | null;
  readonly parentRunId?: RunId | null;
  readonly cwd?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional override — defaults to `DEFAULT_RUN_CONFIDENCE` (1). */
  readonly confidence?: number;
  /** Optional override — defaults to `DEFAULT_RUN_OUTPUT_TYPE` ('text'). */
  readonly outputType?: OutputType;
  /** Optional row-range anchor when the adapter already knows it. */
  readonly semanticRange?: SemanticRange | null;
  /**
   * Optional starting state. Defaults to `'pending'`. Adapters that know
   * the Run is immediately live (shell path — command already executed by
   * the time the boundary fires) pass `'running'` to skip the pending
   * intermediate and avoid a two-step mutation.
   */
  readonly initialState?: RunState;
}

/**
 * Subset of `Run` the `updateRun` action accepts. We explicitly exclude
 * identity-bearing fields (`id`, `sessionId`, `parentRunId`, `type`,
 * `startedAt`) because mutating them would break DAG invariants and the
 * "runs are immutable once created" mental model. Terminal-state
 * transitions go through `completeRun` / `cancelRun`; `updateRun` is for
 * mid-flight telemetry updates (resource usage, semantic range drift,
 * confidence refinement as the detector gathers more signal).
 */
export type RunPatch = Partial<
  Pick<
    Run,
    | 'state'
    | 'command'
    | 'cwd'
    | 'completedAt'
    | 'exitCode'
    | 'signal'
    | 'confidence'
    | 'resourceUsage'
    | 'outputType'
    | 'semanticRange'
    | 'metadata'
  >
>;

export interface RunStoreState {
  readonly runs: Readonly<Record<RunId, Run>>;
  readonly order: readonly RunId[];
  readonly activeRunId: RunId | null;
}

export interface RunStoreActions {
  startRun(init: StartRunInit): RunId;
  updateRun(id: RunId, patch: RunPatch): void;
  completeRun(id: RunId, exit: number | null, signal?: string | null): void;
  cancelRun(id: RunId, reason?: string): void;
  setActive(id: RunId | null): void;
  getChildren(parentId: RunId): readonly Run[];
  reset(): void;
}

export type RunStore = RunStoreState & RunStoreActions;

const INITIAL: RunStoreState = {
  runs: {},
  order: [],
  activeRunId: null,
};

/**
 * Generate a new RunId. Prefers `crypto.randomUUID`, falls back to a
 * millis+random combo for test environments that stub globals. The result
 * is cast to the branded type — the brand is documentation-only.
 */
function nextRunId(): RunId {
  const g = globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID() as RunId;
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0');
  return `run_${ts}_${rand}` as RunId;
}

function emptyUsage(): ResourceUsage | null {
  return null;
}

export const useRunsStore = create<RunStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    startRun: (init) => {
      const id = nextRunId();
      const now = Date.now();
      const run: Run = {
        id,
        type: init.type,
        parentRunId: init.parentRunId ?? null,
        sessionId: init.sessionId,
        state: init.initialState ?? 'pending',
        command: init.command ?? null,
        cwd: init.cwd ?? '',
        startedAt: now,
        completedAt: null,
        exitCode: null,
        signal: null,
        confidence: init.confidence ?? DEFAULT_RUN_CONFIDENCE,
        resourceUsage: emptyUsage(),
        outputType: init.outputType ?? DEFAULT_RUN_OUTPUT_TYPE,
        semanticRange: init.semanticRange ?? null,
        metadata: init.metadata ?? {},
      };
      set((prev) => ({
        runs: { ...prev.runs, [id]: run },
        order: [...prev.order, id],
        // Auto-focus: a freshly-started Run becomes active unless the
        // caller later clears it. Mirrors the Block store's `startBlock`.
        activeRunId: id,
      }));
      return id;
    },

    updateRun: (id, patch) =>
      set((prev) => {
        const existing = prev.runs[id];
        if (!existing) return prev;
        // Audit: reject updates to terminal runs — once settled, the run
        // is immutable. Adapter callers that race a late telemetry update
        // against a terminal transition will see the update silently
        // dropped, which is the right behavior (the final state wins).
        if (isTerminalRunState(existing.state)) return prev;
        const next: Run = {
          ...existing,
          ...patch,
          // Patch can't override identity-bearing fields — spread order
          // ensures the original id / type / parentRunId / sessionId /
          // startedAt survive even if the caller tries to smuggle them.
          id: existing.id,
          type: existing.type,
          parentRunId: existing.parentRunId,
          sessionId: existing.sessionId,
          startedAt: existing.startedAt,
        };
        return { ...prev, runs: { ...prev.runs, [id]: next } };
      }),

    completeRun: (id, exit, signal) =>
      set((prev) => {
        const existing = prev.runs[id];
        if (!existing) return prev;
        if (isTerminalRunState(existing.state)) return prev;
        const now = Date.now();
        const next: Run = {
          ...existing,
          state: 'completed',
          exitCode: exit,
          signal: signal ?? null,
          completedAt: now,
        };
        return {
          ...prev,
          runs: { ...prev.runs, [id]: next },
          activeRunId: prev.activeRunId === id ? null : prev.activeRunId,
        };
      }),

    cancelRun: (id, reason) =>
      set((prev) => {
        const existing = prev.runs[id];
        if (!existing) return prev;
        if (isTerminalRunState(existing.state)) return prev;
        const now = Date.now();
        // Stash the reason in metadata — the cancel path otherwise has no
        // place to record it, and a separate top-level field would clutter
        // the entity for the common case (no reason supplied).
        const nextMetadata =
          reason === undefined
            ? existing.metadata
            : { ...existing.metadata, cancelReason: reason };
        const next: Run = {
          ...existing,
          state: 'canceled',
          completedAt: now,
          metadata: nextMetadata,
        };
        return {
          ...prev,
          runs: { ...prev.runs, [id]: next },
          activeRunId: prev.activeRunId === id ? null : prev.activeRunId,
        };
      }),

    setActive: (id) =>
      set((prev) => {
        // Unknown ids are rejected. A null clears unconditionally —
        // closing a session or receiving a pty_exit is a legitimate reason
        // to clear the pointer even if it currently points at an unknown
        // (already-removed) Run.
        if (id !== null && !prev.runs[id]) return prev;
        if (prev.activeRunId === id) return prev;
        return { ...prev, activeRunId: id };
      }),

    getChildren: (parentId) => {
      const state = get();
      const out: Run[] = [];
      for (const id of state.order) {
        const run = state.runs[id];
        if (run && run.parentRunId === parentId) out.push(run);
      }
      return out;
    },

    reset: () => set(() => ({ ...INITIAL })),
  })),
);

// ----- Selectors -----

/**
 * Single-Run selector. Returns `undefined` for unknown ids so callers can
 * handle both "never existed" and "cleared" paths with one branch.
 */
export function useRun(id: RunId | null): Run | undefined {
  return useRunsStore((s) => (id === null ? undefined : s.runs[id]));
}

/**
 * Currently-active Run. Returns `undefined` when none is active, which is
 * the default steady state when nothing is in flight.
 */
export function useActiveRun(): Run | undefined {
  return useRunsStore((s) => (s.activeRunId === null ? undefined : s.runs[s.activeRunId]));
}

/**
 * Every Run belonging to a given session, in insertion order. The hook
 * returns a NEW array on every store change that affects this session —
 * consumers who care about reference stability can wrap with `useShallow`
 * or memoize on the array's length + tail id.
 *
 * Included deliberately without `useShallow` at this layer: shallow-compare
 * on a mixed-session store makes cross-session writes re-run this selector
 * even when its filtered output is identical. The cost of a tiny fresh
 * array is lower than a shallow-walk over `runs[*]`.
 */
export function useRunsBySession(sessionId: SessionId): readonly Run[] {
  return useRunsStore((s) => {
    const out: Run[] = [];
    for (const id of s.order) {
      const run = s.runs[id];
      if (run && run.sessionId === sessionId) out.push(run);
    }
    return out;
  });
}

/**
 * Stateless helper for non-React consumers (adapter layer, tests). Takes a
 * state snapshot — callers should pass `useRunsStore.getState()` unless
 * they are threading a specific snapshot (e.g. replay).
 */
export function getChildrenFromState(state: RunStoreState, parentId: RunId): readonly Run[] {
  const out: Run[] = [];
  for (const id of state.order) {
    const run = state.runs[id];
    if (run && run.parentRunId === parentId) out.push(run);
  }
  return out;
}
