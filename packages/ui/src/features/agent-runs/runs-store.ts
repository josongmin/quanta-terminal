/**
 * Mock Run store — stand-in surface for W2-D's `entities/run/runs-store.ts`.
 *
 * Scope: this module exists only because P2-E lands ahead of W2-D in the
 * parallel plan. It models the minimum Run surface this slice needs so
 * `AgentRunCard` can render without a stub in every test. When the real
 * `runs-store` lands, the public surface of this file should migrate
 * wholesale into `entities/run/` and the feature slice re-exports a
 * thin adapter.
 *
 * Shape
 * -----
 * A `Run` is the unit produced by either a shell submit (future) or an
 * agent invocation (this slice). `type: 'agent'` records tool-call
 * metadata; `type: 'shell'` would hold `command` text. Both render as
 * peer cards in the grid, distinguished by `type` for the chrome
 * differentiation described in the plan.
 *
 * Storage shape mirrors the existing Block store: normalized entity
 * map + ordered id list. Selectors read individual entries without
 * scanning the list. Non-persisted — Run state is session-scoped for
 * the purposes of the P2 plan.
 *
 * Thread-safety / re-entrancy: zustand's set() is synchronous, so the
 * runner can fire `appendRunOutput` from inside the stream callback
 * without risking a re-entrant update racing an external subscriber.
 */

import { create } from 'zustand';

export type RunStatus = 'running' | 'completed' | 'error' | 'canceled';

/**
 * A Run is a single unit of work displayed as a card in the grid. Both
 * shell commands and agent tool-calls are Runs; the discriminant
 * `type` drives the chrome (color, icon, summary row).
 */
export interface Run {
  readonly id: string;
  readonly type: 'shell' | 'agent';
  /** Shell: the command the user submitted. Agent: always null. */
  readonly command: string | null;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  /** Raw streamed bytes. Agent runs append synthesized output bytes here. */
  readonly outputChunks: readonly Uint8Array[];
  /**
   * Free-form metadata. For agent runs: `{ tool, args, source, confidence }`.
   * Typed loosely so a future real Run entity can add more fields without a
   * store migration in this slice.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RunsState {
  readonly order: readonly string[];
  readonly entities: Readonly<Record<string, Run>>;
}

export interface RunsActions {
  readonly createRun: (
    init: Omit<Run, 'outputChunks' | 'status' | 'completedAt' | 'exitCode'> &
      Partial<Pick<Run, 'outputChunks'>>,
  ) => string;
  readonly appendRunOutput: (id: string, bytes: Uint8Array) => void;
  readonly completeRun: (id: string, exitCode: number) => void;
  readonly errorRun: (id: string, message: string) => void;
  readonly cancelRun: (id: string) => void;
  readonly resetAll: () => void;
}

export type RunsStore = RunsState & RunsActions;

const INITIAL_STATE: RunsState = {
  order: [],
  entities: {},
};

export const useRunsStore = create<RunsStore>((set) => ({
  ...INITIAL_STATE,
  createRun: (init) => {
    const id = init.id;
    const run: Run = {
      id,
      type: init.type,
      command: init.command,
      status: 'running',
      startedAt: init.startedAt,
      completedAt: null,
      exitCode: null,
      outputChunks: init.outputChunks ?? [],
      metadata: init.metadata,
    };
    set((s) => ({
      order: [...s.order, id],
      entities: { ...s.entities, [id]: run },
    }));
    return id;
  },
  appendRunOutput: (id, bytes) => {
    set((s) => {
      const prev = s.entities[id];
      if (!prev) return s;
      const next: Run = {
        ...prev,
        outputChunks: [...prev.outputChunks, bytes],
      };
      return { ...s, entities: { ...s.entities, [id]: next } };
    });
  },
  completeRun: (id, exitCode) => {
    set((s) => {
      const prev = s.entities[id];
      if (!prev) return s;
      const next: Run = {
        ...prev,
        status: exitCode === 0 ? 'completed' : 'error',
        completedAt: Date.now(),
        exitCode,
      };
      return { ...s, entities: { ...s.entities, [id]: next } };
    });
  },
  errorRun: (id, message) => {
    set((s) => {
      const prev = s.entities[id];
      if (!prev) return s;
      const next: Run = {
        ...prev,
        status: 'error',
        completedAt: Date.now(),
        metadata: { ...prev.metadata, errorMessage: message },
      };
      return { ...s, entities: { ...s.entities, [id]: next } };
    });
  },
  cancelRun: (id) => {
    set((s) => {
      const prev = s.entities[id];
      if (!prev) return s;
      if (prev.status !== 'running') return s;
      const next: Run = {
        ...prev,
        status: 'canceled',
        completedAt: Date.now(),
      };
      return { ...s, entities: { ...s.entities, [id]: next } };
    });
  },
  resetAll: () => {
    set({ ...INITIAL_STATE });
  },
}));

/* ---------------------------- Selectors -------------------------------- */

/** Subscribe to a single Run by id. Returns undefined for unknown ids. */
export function useRun(id: string | null): Run | undefined {
  return useRunsStore((s) => (id ? s.entities[id] : undefined));
}

/** Subscribe to the ordered id list. */
export function useRunIds(): readonly string[] {
  return useRunsStore((s) => s.order);
}
