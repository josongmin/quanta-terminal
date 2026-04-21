/**
 * Hybrid boundary-detector event shapes.
 *
 * The hybrid detector (see `hybrid-detector.ts`) fuses three independent
 * signals — OSC 133 authoritative markers, heuristic prompt-regex matches,
 * and an idle-timeout backstop — into one confidence-stamped event stream.
 * Downstream chrome can render `'authoritative'` boundaries differently from
 * `'heuristic'` ones (e.g. a dotted vs solid underline on the exit-code
 * badge) without the detector having to pick winners at emission time.
 *
 * Why a separate types module
 * ---------------------------
 * These shapes are consumed by tests, by the router, and by future chrome
 * widgets. Keeping them in a standalone module means any consumer can depend
 * on the shapes without pulling in the detector implementation (which
 * transitively imports timers, OSC parsers, and the VT emulator hooks).
 * Tests in particular benefit: the 4 test files cross-reference these types
 * via `import type` only.
 */

/**
 * The four canonical boundary events produced by the detector. They map
 * 1:1 onto OSC 133's A/B/C/D markers even when a different signal (regex,
 * cursor-home, idle) is what actually triggered the emission — the event
 * *kind* describes the shell lifecycle position, not the source.
 *
 *   - `prompt_start`  — the shell has begun drawing its PS1 (OSC 133 A).
 *   - `command_start` — user pressed Enter; PS1 finished (OSC 133 B/C).
 *   - `output_start`  — command output begins (OSC 133 C, redundant with B
 *                        for most shells but distinguishable for bracketed-
 *                        paste-aware shells).
 *   - `command_end`   — the command finished; exit code, cwd, and duration
 *                        may be available (OSC 133 D).
 *
 * Heuristic and idle sources never produce all four: the regex detector
 * only fires `prompt_start`, idle only fires `command_end`, cursor-home
 * only fires `prompt_start`. Consumers that need the full lifecycle should
 * gate on `source === 'osc133'`.
 */
export type BoundaryEventKind =
  | 'prompt_start'
  | 'command_start'
  | 'output_start'
  | 'command_end';

/**
 * Which signal in the hybrid detector produced this event. Ordered by
 * confidence (highest first):
 *
 *   - `osc133`          — ESC `]133;X` marker from shell-integration rc scripts.
 *                         Unambiguous: 1.0 confidence.
 *   - `heuristic_regex` — prompt-regex match at start-of-line after LF.
 *                         Confidence in the 0.6–0.8 band depending on how
 *                         well-anchored the match is (bare `$ ` vs themed
 *                         `(main) [~/src] %%` both qualify here).
 *   - `cursor_home`     — CSI `H` (cursor home) followed by CSI `K` (erase
 *                         line) — the classic prompt-redraw signature.
 *                         Confidence 0.5; less reliable than regex because
 *                         any full-screen TUI uses the same sequence.
 *   - `idle`            — 400 ms silence backstop. Confidence 0.1; only
 *                         fires when no higher-tier signal has spoken
 *                         within the last `idleTimeoutMs`.
 */
export type BoundarySource =
  | 'osc133'
  | 'heuristic_regex'
  | 'cursor_home'
  | 'idle';

/**
 * A single boundary emission. The router multiplexes these into the block
 * store; downstream chrome (P1-C) will style blocks based on `source` and
 * `confidence`.
 *
 * Fields
 * ------
 * `exitCode`, `cwd`, and `durationMs` are present ONLY on
 * `kind === 'command_end'` from an `osc133` source — the other signals
 * cannot extract them. Consumers should feature-detect via `source` before
 * relying on these fields.
 *
 * `at_ms` is the timestamp of emission (the now-value passed via `feed` or
 * `tick`). Kept here so telemetry + suppression windows do not need to
 * consult an external clock.
 */
export interface BoundaryEvent {
  readonly kind: BoundaryEventKind;
  readonly source: BoundarySource;
  /**
   * 0..1 confidence the emission represents a true boundary. Baseline:
   * 1.0 for osc133, 0.7 for regex, 0.5 for cursor-home, 0.1 for idle.
   * Individual emissions may adjust within their tier (e.g. a regex match
   * on a shell-integration-installed session pegs at 0.8 because the
   * shell is known to be a real prompt-emitting shell; on a missing
   * session it stays at 0.6).
   */
  readonly confidence: number;
  readonly at_ms: number;
  /**
   * Shell's exit status. `null` when the source can't extract one (every
   * non-osc133 source); `undefined` on non-`command_end` kinds. Omitted
   * field on malformed OSC 133 D payloads — see hybrid-detector test #13
   * for the graceful-degrade contract.
   */
  readonly exitCode?: number | null;
  /** Current working directory reported in OSC 133 D's payload. */
  readonly cwd?: string;
  /** Command wall-clock duration reported in OSC 133 D's payload. */
  readonly durationMs?: number;
}

/**
 * The hybrid detector's public port. Mirrors the shape of `BoundaryDetector`
 * in `boundary-detector.ts` but emits structured events instead of a single
 * "did we boundary?" flag, so multiple events can surface per chunk (e.g.
 * a full `A → B → C → D` cycle in one PTY flush).
 *
 * `feed` and `tick` both return newly-emitted events in the order they
 * happened. `tick` exists so tests can advance the idle timer without
 * shipping bytes; production code may wire it to a `requestAnimationFrame`
 * or `setInterval` loop, or rely on the internal `setTimeout` driven by
 * `feed` (the default).
 */
export interface HybridBoundaryDetector {
  /**
   * Consume a raw PTY chunk and return any boundary events fired by it.
   * Events are ordered by `at_ms`; a single feed may emit multiple events
   * when the chunk contains a full OSC 133 B→C→D sequence.
   */
  feed(bytes: Uint8Array): BoundaryEvent[];
  /**
   * Pulse the idle timer. Called internally from `feed` when bytes arrive
   * and externally by tests / polling loops. If the idle window has
   * elapsed since the last signal, emits a `command_end` idle event.
   */
  tick(nowMs: number): BoundaryEvent[];
  /**
   * Enable or disable individual signal sources. Used by the router to
   * turn off `osc133` on shell-integration-missing sessions, and by tests
   * to isolate heuristic behavior. Any source not mentioned in the patch
   * retains its current state.
   */
  setSignals(enabled: Partial<Record<BoundarySource, boolean>>): void;
  /** Clear all buffers and timers. Returns the detector to install state. */
  reset(): void;
}

/**
 * Input options. See `createHybridBoundaryDetector` in the impl module.
 *
 * `shellIntegration`
 *   `'installed'` / `'detected'` — enable osc133 source at full confidence;
 *     regex boost to 0.8; idle tier armed as backstop only.
 *   `'missing'`   — osc133 signal still watched (in case the shell emits
 *     it anyway from a user-supplied rc snippet we didn't install) but
 *     regex + idle carry the load.
 */
export interface HybridBoundaryDetectorOptions {
  readonly shellIntegration: 'installed' | 'detected' | 'missing';
  /** Milliseconds of silence before the idle backstop fires. Default 400. */
  readonly idleTimeoutMs?: number;
  /**
   * Time window during which a lower-confidence event is suppressed when
   * a higher-confidence event for the same kind has already fired.
   * Default 200 ms.
   */
  readonly suppressionWindowMs?: number;
  /**
   * Regexes used by the `heuristic_regex` source to identify a prompt at
   * the start of a line. Default set covers `$ ` (bash/sh), `% ` (zsh),
   * `# ` (root), `> ` (continuation / nushell) at column 0. Consumers may
   * override for themed prompts.
   */
  readonly promptPatterns?: readonly RegExp[];
  /**
   * Optional sink for every emission (after suppression). Intended for
   * telemetry — the return value of `feed`/`tick` already carries the
   * events, so this is strictly a side-channel for metrics.
   */
  readonly onEvent?: (event: BoundaryEvent) => void;
  /**
   * Optional sink for events that WERE suppressed by the confidence
   * arbitration layer. Fired on top of `onEvent` with the suppressed event
   * so telemetry can count "how often heuristic would have won if OSC 133
   * weren't there" without having to reproduce the arbitration logic.
   */
  readonly onSuppressed?: (event: BoundaryEvent) => void;
  /**
   * Clock injection for deterministic tests. Defaults to `Date.now`.
   * The detector calls this each time it needs a timestamp (feed entry,
   * event emission, idle check). Tests that use `vi.useFakeTimers` can
   * leave this at the default; tests that want to drive time explicitly
   * can pass a function returning a monotonically-increasing millisecond
   * counter.
   */
  readonly now?: () => number;
}
