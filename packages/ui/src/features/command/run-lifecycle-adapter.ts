/**
 * Run-lifecycle adapter — Plan 0005 P2-A.
 *
 * Bridges boundary-detection events (the eventual P1-A hybrid detector) into
 * the Run store. One installed adapter per session. The adapter is dormant
 * when `flag.runEntity` is false — `emitBoundaryEvent` short-circuits and
 * no Run is ever created.
 *
 * Boundary event surface
 * ----------------------
 * The P1-A hybrid detector that will ultimately drive this adapter is not
 * yet implemented. To avoid coupling this module to a non-existent API we
 * define a small event surface here:
 *
 *   emitBoundaryEvent({ kind: 'prompt_start', sessionId, command?, cwd?, confidence?, semanticRange?, metadata? })
 *   emitBoundaryEvent({ kind: 'command_end', sessionId, runId?, exitCode, signal? })
 *
 * Adapters installed via `installRunLifecycleAdapter(sessionId)` subscribe
 * to events for their session. When `prompt_start` fires, the adapter
 * allocates a new shell Run and marks it active. When `command_end` fires,
 * the adapter completes the active Run (or the one referenced by `runId`
 * in the event, if present) with the exit code. Out-of-order events
 * (command_end without a prior prompt_start) are dropped and logged.
 *
 * This indirection is intentional: when the real P1-A detector lands it
 * wires itself to `emitBoundaryEvent`; this adapter needs zero changes.
 * The adapter is testable today via the same entry point.
 *
 * Flag gating
 * -----------
 * Both `installRunLifecycleAdapter` and `emitBoundaryEvent` consult
 * `getFeatureFlag('runEntity')` on EVERY call. Flipping the flag at
 * runtime thus activates / deactivates the adapter without a reload.
 * When the flag is off the adapter's install is a no-op that returns a
 * disposer that does nothing — safe to call unconditionally from higher-
 * level wiring.
 */

import type { SessionId } from '../../shared/types/generated/index.js';
import { getFeatureFlag } from '../../shared/config/feature-flags.js';
import { createLogger } from '../../shared/lib/logger.js';
import {
  useRunsStore,
  type RunId,
  type SemanticRange,
} from '../../entities/run/index.js';

const log = createLogger('command.run-lifecycle-adapter');

/**
 * Prompt-start event — detector observed the start of a new command.
 * The adapter creates a shell Run with `initialState: 'running'` and
 * activates it.
 */
export interface PromptStartEvent {
  readonly kind: 'prompt_start';
  readonly sessionId: SessionId;
  /** Command line text if the detector captured it; many prompt detectors
   *  see only the boundary marker and not the trailing command — then null. */
  readonly command?: string | null;
  readonly cwd?: string;
  readonly confidence?: number;
  readonly semanticRange?: SemanticRange | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Command-end event — detector observed the end of the current command
 * (OSC 133 D, or prompt-regex redraw). The adapter completes the currently-
 * active Run for the session. An explicit `runId` overrides the "active
 * Run" lookup — useful when events arrive out of order under replay.
 */
export interface CommandEndEvent {
  readonly kind: 'command_end';
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly exitCode: number | null;
  readonly signal?: string | null;
}

export type BoundaryEvent = PromptStartEvent | CommandEndEvent;

type AdapterHandle = {
  readonly sessionId: SessionId;
  /** The current in-flight Run id for this session, if any. Null whenever
   *  the adapter has not yet seen a `prompt_start` or has already paired
   *  the last one with a `command_end`. */
  currentRunId: RunId | null;
};

const adapters = new Map<SessionId, AdapterHandle>();

export interface InstallRunLifecycleAdapterResult {
  readonly dispose: () => void;
}

/**
 * Install the Run-lifecycle adapter for a session. Idempotent per-session:
 * re-installing replaces the existing handle. The returned disposer
 * clears the handle; if the run that was in-flight at dispose-time is
 * still running, it is canceled with reason `'adapter-disposed'` so the
 * store never leaks runs past an adapter teardown.
 *
 * No-op when `flag.runEntity` is off — returns a disposer that does
 * nothing. Call sites can install unconditionally.
 */
export function installRunLifecycleAdapter(
  sessionId: SessionId,
): InstallRunLifecycleAdapterResult {
  if (!getFeatureFlag('runEntity')) {
    return { dispose: () => undefined };
  }
  // Replace an existing handle — clean up first so the prior in-flight
  // Run does not orphan. The replacement is legitimate in test reset
  // flows and in hot-reload scenarios.
  const existing = adapters.get(sessionId);
  if (existing) {
    disposeHandle(existing);
  }
  const handle: AdapterHandle = { sessionId, currentRunId: null };
  adapters.set(sessionId, handle);
  return {
    dispose: () => {
      // If someone replaced us mid-flight, leave the new adapter alone.
      if (adapters.get(sessionId) !== handle) return;
      disposeHandle(handle);
      adapters.delete(sessionId);
    },
  };
}

function disposeHandle(handle: AdapterHandle): void {
  if (handle.currentRunId !== null) {
    useRunsStore.getState().cancelRun(handle.currentRunId, 'adapter-disposed');
    handle.currentRunId = null;
  }
}

/**
 * Central emit point. Flag-gated — when `runEntity` is off, the event is
 * silently dropped. When on, the matching adapter handles the event; if
 * no adapter is registered for the session, the event is dropped with a
 * debug log (this is legitimate during early boot before the adapter
 * installs, or in a session that opted out of run tracking).
 *
 * This is the only public sink for boundary events. Tests call it directly;
 * the future P1-A hybrid detector will call it from its output pipeline.
 */
export function emitBoundaryEvent(event: BoundaryEvent): void {
  if (!getFeatureFlag('runEntity')) return;
  const handle = adapters.get(event.sessionId);
  if (!handle) {
    log.debug('boundary event with no adapter', event.kind, event.sessionId);
    return;
  }
  if (event.kind === 'prompt_start') {
    handlePromptStart(handle, event);
  } else {
    handleCommandEnd(handle, event);
  }
}

function handlePromptStart(handle: AdapterHandle, event: PromptStartEvent): void {
  const store = useRunsStore.getState();
  // If a Run from a prior command was still in-flight (no command_end
  // received — happens when the detector misses a boundary), cancel it
  // with a reason so the UI can mark it "abandoned" rather than leaving
  // it spinning forever.
  if (handle.currentRunId !== null) {
    store.cancelRun(handle.currentRunId, 'superseded-by-next-prompt');
  }
  // With `exactOptionalPropertyTypes`, we can't pass `undefined` to a
  // `number` field. Only include `confidence` when the event supplied one;
  // the store falls back to `DEFAULT_RUN_CONFIDENCE`.
  const init: Parameters<typeof store.startRun>[0] = {
    sessionId: event.sessionId,
    type: 'shell',
    command: event.command ?? null,
    cwd: event.cwd ?? '',
    semanticRange: event.semanticRange ?? null,
    metadata: event.metadata ?? {},
    initialState: 'running',
  };
  if (event.confidence !== undefined) {
    (init as { confidence?: number }).confidence = event.confidence;
  }
  const id = store.startRun(init);
  handle.currentRunId = id;
}

function handleCommandEnd(handle: AdapterHandle, event: CommandEndEvent): void {
  const store = useRunsStore.getState();
  const target = event.runId ?? handle.currentRunId;
  if (target === null || target === undefined) {
    // No Run to close — could be the detector's first event, or a
    // duplicated end from a noisy detector. Dropping is safe.
    log.debug('command_end with no active run', event.sessionId);
    return;
  }
  store.completeRun(target, event.exitCode, event.signal ?? null);
  // If the event targeted the handle's current run (the common case),
  // clear the pointer so the next prompt_start allocates fresh.
  if (target === handle.currentRunId) {
    handle.currentRunId = null;
  }
}

// ----- Test helpers -----

/** Test-only: wipe every adapter. Production code uses `dispose()` on the
 *  per-session handle. */
export function __resetRunLifecycleAdaptersForTests(): void {
  for (const handle of adapters.values()) {
    disposeHandle(handle);
  }
  adapters.clear();
}

/** Test-only: peek at the current in-flight Run for a session. */
export function __getCurrentRunIdForTests(sessionId: SessionId): RunId | null {
  return adapters.get(sessionId)?.currentRunId ?? null;
}

/** Test-only: whether an adapter is currently registered for a session. */
export function __hasAdapterForTests(sessionId: SessionId): boolean {
  return adapters.has(sessionId);
}
