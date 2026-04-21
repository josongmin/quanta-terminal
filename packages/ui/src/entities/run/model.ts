/**
 * Run entity — Plan 0005 P2-A.
 *
 * The Run is the first-class lifecycle concept for *any* unit of work the
 * terminal kicks off, not just a shell command. A Run wraps / subsumes the
 * P1 Block: one shell submission is one Run of `type: 'shell'`, but an AI
 * tool-call, a background task, a replay, or a nested subrun are ALSO Runs.
 * This generalization lets later epics (W2-E Intent layer, W2-G Agent
 * surface, P2-E replay) plug into a single state machine instead of inventing
 * parallel lifecycle concepts.
 *
 * Relationship to Block
 * ---------------------
 * - P1 blocks remain the source of truth for rendered chunk history.
 * - A Run owns a lifecycle pointer, a DAG parent, resource telemetry, and a
 *   semantic row-range slice into the session buffer. A Block may be the
 *   rendered projection of a `type: 'shell'` Run; the `runId` field on Block
 *   (added in this epic) lets the view join them.
 * - When `flag.runEntity` is false (P2 opt-in default), the Run store is
 *   simply unused — blocks keep their P1 shape and nothing reads `runId`.
 *   Flipping the flag enables the lifecycle adapter that creates Runs from
 *   boundary events.
 *
 * Schema design — what's a first-class field vs. what lives in `metadata`
 * ----------------------------------------------------------------------
 * Fields that every RunType needs for lifecycle reasoning OR for selectors
 * are first-class: `id`, `type`, `parentRunId`, `sessionId`, `state`,
 * `command`, `cwd`, timestamps, `exitCode`, `signal`, `confidence`,
 * `resourceUsage`, `outputType`, `semanticRange`. Everything type-specific
 * (agent model id, tool name, replay source, background task label…) goes
 * in `metadata: Record<string, unknown>`. Keeping the typed surface small
 * means selectors and the DAG walk don't need RunType-aware branches.
 *
 * Immutability
 * ------------
 * Every field is `readonly`. Mutations go through the store actions, which
 * rebuild the entity — this keeps zustand's shallow selector comparisons
 * efficient and prevents consumers from patching the Run behind the store's
 * back. `metadata` is also readonly; mutating its content requires replacing
 * the whole object through `updateRun`.
 */

import type { SessionId } from '../../shared/types/generated/index.js';

/**
 * Stable id for a Run. Kept as a branded string alias (not a nominal type)
 * so it is JSON-safe and ergonomic across FFI boundaries; the brand is
 * documentation-only at the TS level.
 */
export type RunId = string & { readonly __brand: 'RunId' };

/**
 * Categorical type of a Run. The enum is closed — every new kind of work
 * unit needs an explicit entry here so the adapter layer can route it. A
 * `subrun` is a nested Run whose parent is itself a Run (e.g. a shell Run
 * that spawns a build subcommand we want tracked separately).
 */
export type RunType = 'shell' | 'task' | 'agent' | 'replay' | 'subrun';

/**
 * Lifecycle state of a Run. Transitions:
 *   pending → running                    (adapter arms the Run)
 *   running → completed | failed | canceled | killed | suspended
 *   suspended → running                  (resumed)
 *   any terminal → NO further transitions
 *
 * `failed` is distinct from `completed` with a non-zero exit code: a shell
 * command that exits 1 is `completed` with `exitCode: 1`, while `failed` is
 * reserved for runs that never reached a meaningful exit at all (e.g. spawn
 * error, agent tool-use rejected). `killed` means the host sent a signal;
 * `canceled` means the user requested cancellation before the process could
 * signal its own exit. The distinction matters for UI badges and retry
 * policy.
 */
export type RunState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'killed'
  | 'suspended';

/**
 * What kind of output this Run produces. Used by the UI to pick a renderer
 * without re-parsing the bytes. `text` is the default for shell. `table`
 * is reserved for structured-output runs (e.g. `kubectl get` with JSON);
 * `progress` is a Run that only emits progress deltas; `json-stream` is
 * NDJSON (one JSON doc per line); `binary` is an opaque blob the UI treats
 * as download-only.
 */
export type OutputType = 'text' | 'table' | 'progress' | 'json-stream' | 'binary';

/**
 * Resource telemetry snapshot. Populated on terminal transitions when the
 * host can supply it (`getrusage` on POSIX, perf counters on Windows).
 * Null-valued by default — a run without telemetry does NOT make this
 * optional at the type level; null keeps the shape stable for consumers.
 */
export interface ResourceUsage {
  readonly cpuMs: number;
  readonly rssPeakKb: number;
  readonly ioBytes: number;
}

/**
 * Row-range slice into the session buffer. Populated when the boundary
 * detector's hybrid strategy can localize the Run to specific terminal
 * rows (OSC 133 reports them directly; prompt-regex fallback estimates).
 * Null when unknown — a block that can't be row-anchored (e.g. an agent
 * Run that has no screen representation) lives fine without it.
 */
export interface SemanticRange {
  readonly promptStartRow: number;
  readonly commandStartRow: number;
  readonly outputStartRow: number;
  readonly outputEndRow: number;
}

/**
 * The Run itself. See module docblock for the "first-class vs metadata"
 * rule. `parentRunId` is the DAG pointer — null for top-level Runs; set for
 * subruns or tool-call Runs whose parent is the shell Run that initiated
 * them. `confidence` carries the boundary-detection confidence (0..1) so
 * the UI can flag low-confidence Runs with a "degraded" badge.
 */
export interface Run {
  readonly id: RunId;
  readonly type: RunType;
  readonly parentRunId: RunId | null;
  readonly sessionId: SessionId;
  readonly state: RunState;
  /** Primary command-line / prompt text. Null for Runs that don't have
   *  one (e.g. a passive replay with no re-executable command). */
  readonly command: string | null;
  readonly cwd: string;
  /** Wall-clock epoch-ms when the Run entered `running`. Set to the same
   *  timestamp as the store's `startRun` call even when the Run starts
   *  `pending` — consumers read `state` to disambiguate. */
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Detection confidence, 0..1. `1` = OSC 133 authoritative; lower for
   *  prompt-regex fallbacks. Default `1` for adapter calls that don't
   *  carry a confidence score (the test path, the legacy shell path). */
  readonly confidence: number;
  readonly resourceUsage: ResourceUsage | null;
  readonly outputType: OutputType;
  readonly semanticRange: SemanticRange | null;
  /**
   * Untyped per-RunType bag. The adapter / feature code owns the shape;
   * the Run entity deliberately refuses to narrow it because doing so
   * would turn the entity into a discriminated union and force every
   * selector to branch on `type`.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The set of Run states that represent a settled outcome. Once a Run
 * enters any of these, the store rejects further mutations to its
 * lifecycle-bearing fields. Exported so selectors and the adapter share
 * one definition.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'completed',
  'failed',
  'canceled',
  'killed',
]);

/**
 * Pure predicate — `true` when the run is in a terminal state.
 */
export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

/**
 * Default confidence when the caller does not supply one. Chosen `1` so
 * the legacy shell path (which has always been treated as authoritative)
 * does not suddenly flip every Run into the "degraded" badge branch.
 */
export const DEFAULT_RUN_CONFIDENCE = 1;

/**
 * Default output type for a shell Run. Non-shell Runs set their own.
 */
export const DEFAULT_RUN_OUTPUT_TYPE: OutputType = 'text';
