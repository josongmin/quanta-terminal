/**
 * Public surface of `features/agent-runs` — Plan 0005 P2-E.
 *
 * Exports the agent action types, the runner interface + mock impl,
 * and the local mock run-store (which will move to `entities/run/`
 * when W2-D lands).
 */

export type { AgentAction, AgentRunSpec } from './agent-action-types.js';
export { isStreamActionFor, assertNever } from './agent-action-types.js';

export type {
  AgentRunner,
  AgentRunHandle,
  RunnerScheduler,
  ManualScheduler,
} from './agent-runner.js';
export {
  createMockAgentRunner,
  bindAgentRunner,
  getAgentRunner,
  resetAgentRunnerForTests,
  createManualScheduler,
  mockChunksForSpec,
  DEFAULT_SCHEDULER,
  MOCK_RUN_CHUNK_COUNT,
} from './agent-runner.js';

export type { Run, RunStatus, RunsStore, RunsState, RunsActions } from './runs-store.js';
export { useRunsStore, useRun, useRunIds } from './runs-store.js';
