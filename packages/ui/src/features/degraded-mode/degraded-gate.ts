/**
 * Degraded gate — the production seam through which input-write paths
 * consult the degraded-mode state.
 *
 * Why a port (and not a direct hook import)
 * -----------------------------------------
 * The degraded banner lives in React state (`useDegradedMode`), but the
 * production write sites (`features/command/execute.ts`, the
 * `ConnectedSession.write` wrapper in `features/session/connect.ts`) are
 * imperative modules that cannot call a hook. Importing the hook's module
 * into those sites would also violate FSD: the command and session slices
 * must not depend on the degraded-mode feature internals.
 *
 * Contract (RFC §20, ADR 0010, EPIC-H §4.4):
 *   - When the engine is considered dead the UI shows a banner and **input
 *     is disabled**. "Disabled" here means: the bytes never reach the host
 *     bridge, and we increment a telemetry counter so the drop is
 *     observable (the `droppedInputs` field on the hook's status).
 *   - The gate is "conservative" per the task spec: when `isDegraded` is
 *     true we always drop + count; we never silently redirect or retry.
 *
 * Binding lifecycle
 * -----------------
 *   - `TerminalPage` calls `bindDegradedGate({ isDegraded, reportDroppedInput })`
 *     with closures over the `useDegradedMode` handle. The effect returns a
 *     disposer that clears the gate on unmount so tests and HMR don't leak
 *     stale references.
 *   - Callers on the write path use `tryGetDegradedGate()`. If no gate is
 *     bound (headless tests, boot time before TerminalPage mounts) the
 *     write proceeds as before — the gate is an opt-in signal, not a hard
 *     requirement.
 */

export interface DegradedGate {
  /** True when the engine is considered dead per `useDegradedMode`. */
  readonly isDegraded: () => boolean;
  /** Bump the dropped-input telemetry counter on the degraded handle. */
  readonly reportDroppedInput: () => void;
}

let bound: DegradedGate | undefined;

/**
 * Install the degraded gate. Returns a disposer that clears the binding.
 * Late binders replace earlier ones; the disposer restores the previous
 * value so test stacks nest cleanly.
 */
export function bindDegradedGate(gate: DegradedGate): () => void {
  const prev = bound;
  bound = gate;
  return () => {
    bound = prev;
  };
}

/** Safe lookup. Returns undefined when nothing is bound. */
export function tryGetDegradedGate(): DegradedGate | undefined {
  return bound;
}

/** Test hygiene hook — clear the binding without a disposer. */
export function __resetDegradedGateForTests(): void {
  bound = undefined;
}
