/**
 * AgentRunner — the seam between the UI and an AI / tool-call provider.
 *
 * Responsibilities
 * ----------------
 *   - Materialize an agent Run (via `useRunsStore`).
 *   - Emit the `AgentAction` stream that the overlay consumes.
 *   - Forward synthesized output bytes into the run's byte stream so the
 *     grid cell renderer can display tool output alongside shell output.
 *
 * Mock-vs-real boundary (IMPORTANT)
 * ---------------------------------
 * The public interface (`AgentRunner`) is the ONLY thing the UI depends
 * on. The mock implementation below (`createMockAgentRunner`) generates
 * synthetic output and completes with exit 0. A future real runner
 * (backed by `SuggestionPort.runTool(...)` or similar) slots in with an
 * identical surface — no consumer changes required. Because of this,
 * tests exercise the interface via the mock, and integrations bind the
 * real runner at app boot the same way `bindSuggestionPort` does.
 *
 * Cancellation
 * ------------
 * `start()` returns `{ runId, cancel }`. Calling `cancel` stops further
 * stream emissions and flips the run into `canceled` status in the
 * runs-store. The mock honours cancellation on the next scheduled tick
 * (the synthetic interval checks the disposal flag before emitting).
 *
 * Determinism for tests
 * ---------------------
 * The mock's timing is driven by an injectable `scheduler` (default
 * `queueMicrotask`-based) so tests can substitute a synchronous driver
 * and assert on chunk-by-chunk progression without racing `setTimeout`.
 */

import type { AgentAction, AgentRunSpec } from './agent-action-types.js';
import { useRunsStore } from './runs-store.js';

export interface AgentRunHandle {
  readonly runId: string;
  readonly cancel: () => void;
}

export interface AgentRunner {
  /** Start a new agent run from the given spec. */
  start(spec: AgentRunSpec): Promise<AgentRunHandle>;
  /** Subscribe to the action stream. Returns an unsubscribe fn. */
  onStream(listener: (action: AgentAction) => void): () => void;
}

/**
 * Scheduler seam. The mock walks a sequence of `tick()`s; the default
 * implementation uses `queueMicrotask` so a lightweight `await Promise.resolve()`
 * in tests is enough to drain one chunk. Tests can inject a controllable
 * manual scheduler to step by chunk.
 */
export interface RunnerScheduler {
  schedule(fn: () => void): void;
}

export const DEFAULT_SCHEDULER: RunnerScheduler = {
  schedule(fn) {
    // Microtask keeps the synthetic stream deterministic while still
    // letting React re-render between ticks.
    queueMicrotask(fn);
  },
};

/**
 * Number of stream chunks the mock emits before `stream-end`. The plan
 * calls for ~5; exported so tests can reference the exact value without
 * a magic number duplicated across spec files.
 */
export const MOCK_RUN_CHUNK_COUNT = 5;

/** Generate a short run id. Crypto UUID when available; numeric fallback. */
function makeRunId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `run-${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    // fall through
  }
  return `run-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the synthesized text chunks a mock run emits. Deterministic for
 * a given `spec` so snapshot-style tests can assert on the exact bytes.
 *
 * Format:
 *   line 1: "Running tool: <tool>"
 *   line 2: "Args: { "<k>": <v>, ... }" (or "Args: {}" when empty)
 *   lines 3..5: "step 1/3", "step 2/3", "step 3/3"
 *
 * Total chunk count equals `MOCK_RUN_CHUNK_COUNT`.
 */
export function mockChunksForSpec(spec: AgentRunSpec): readonly string[] {
  const argsPreview = safeStringify(spec.args);
  return [
    `Running tool: ${spec.tool}\n`,
    `Args: ${argsPreview}\n`,
    `step 1/3\n`,
    `step 2/3\n`,
    `step 3/3\n`,
  ];
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<unserializable>"';
  }
}

const ENCODER = /* @__PURE__ */ new TextEncoder();

/**
 * Create a mock agent runner. Each invocation produces an independent
 * runner instance with its own listener set — callers that want a
 * global runner (e.g. app-level binding) should create one at boot and
 * export it.
 */
export function createMockAgentRunner(
  options: { readonly scheduler?: RunnerScheduler } = {},
): AgentRunner {
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const listeners = new Set<(action: AgentAction) => void>();

  const emit = (action: AgentAction): void => {
    for (const l of Array.from(listeners)) {
      try {
        l(action);
      } catch {
        // A listener throwing must not take down the stream — the
        // runner is fire-and-forget from its own perspective.
      }
    }
  };

  return {
    async start(spec) {
      const runId = makeRunId();
      const startedAt = Date.now();
      useRunsStore.getState().createRun({
        id: runId,
        type: 'agent',
        command: null,
        startedAt,
        metadata: {
          tool: spec.tool,
          args: spec.args,
          source: spec.source,
          confidence: spec.confidence,
        },
      });

      emit({ kind: 'tool-call', tool: spec.tool, args: { ...spec.args } });
      emit({ kind: 'stream-start', runId });

      const chunks = mockChunksForSpec(spec);
      let cursor = 0;
      let disposed = false;

      const tick = (): void => {
        if (disposed) return;
        if (cursor >= chunks.length) {
          // Completion tick — mark the store completed and emit stream-end.
          useRunsStore.getState().completeRun(runId, 0);
          emit({ kind: 'stream-end', runId, exitCode: 0 });
          return;
        }
        const chunk = chunks[cursor]!;
        cursor += 1;
        const bytes = ENCODER.encode(chunk);
        useRunsStore.getState().appendRunOutput(runId, bytes);
        emit({ kind: 'stream-chunk', runId, bytes });
        scheduler.schedule(tick);
      };

      scheduler.schedule(tick);

      return {
        runId,
        cancel: () => {
          if (disposed) return;
          disposed = true;
          useRunsStore.getState().cancelRun(runId);
          // Emit a synthetic stream-end with a non-zero exit so consumers
          // that only track the stream (not the store) still converge.
          emit({ kind: 'stream-end', runId, exitCode: 130 });
        },
      };
    },

    onStream(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/* ----------------------- Runner registry ------------------------------- */

let installed: AgentRunner = createMockAgentRunner();

/** Bind a runner at app boot. Real providers wire their implementation here. */
export function bindAgentRunner(runner: AgentRunner): void {
  installed = runner;
}

export function getAgentRunner(): AgentRunner {
  return installed;
}

/** Test-only — reset to a fresh mock runner. */
export function resetAgentRunnerForTests(): void {
  installed = createMockAgentRunner();
}

/**
 * Manual scheduler for tests — call `flushAll()` to drain pending ticks
 * synchronously. Useful for stepping through the mock runner one chunk
 * at a time without awaiting microtasks.
 */
export interface ManualScheduler extends RunnerScheduler {
  flushAll(): void;
  flushOne(): boolean;
  readonly pending: number;
}

export function createManualScheduler(): ManualScheduler {
  const queue: Array<() => void> = [];
  return {
    schedule(fn) {
      queue.push(fn);
    },
    flushOne() {
      const next = queue.shift();
      if (!next) return false;
      next();
      return true;
    },
    flushAll() {
      while (queue.length > 0) {
        const next = queue.shift()!;
        next();
      }
    },
    get pending() {
      return queue.length;
    },
  };
}
