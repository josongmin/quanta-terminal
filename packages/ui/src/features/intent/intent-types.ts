/**
 * Intent types — Plan 0005 P2-B.
 *
 * An `Intent` is a meaning-typed user or agent action that precedes byte
 * encoding. The P0 `input-host` happily emits bytes straight to the PTY
 * for every keystroke; P2 introduces an intent router so AI, safety
 * gates, and macro rewriters can inspect/alter/deny actions BEFORE they
 * hit the wire.
 *
 * Why discriminated payloads and not a single `{ text?: string }` bag:
 *   - type safety at call-sites; a `rerun` intent carries a `runId` and
 *     never a `text`, and the compiler enforces that shape;
 *   - gate/rewriter authors can pattern-match on `kind` and narrow
 *     `payload` without runtime defensive checks.
 *
 * Why a `confidence` field:
 *   - user keystrokes are 1.0 (deterministic intent);
 *   - AI-synthesized agent intents ship at 0.7 (reviewable);
 *   - gates can use confidence to require confirmation below a threshold.
 *
 * `originatingTs` is a monotonic timestamp (performance.now on the web,
 * Date.now as a fallback) stamped by the dispatcher at intent creation
 * so replay/compare-runs can reorder events deterministically.
 */

/** The canonical set of meaning-typed actions. */
export type IntentKind =
  | 'execute'
  | 'execute-raw'
  | 'interrupt'
  | 'suspend'
  | 'cancel-run'
  | 'history-search'
  | 'navigate'
  | 'inspect-run'
  | 'copy-output'
  | 'paste'
  | 'rerun'
  | 'compare-runs'
  | 'open-path'
  | 'ai-explain'
  | 'ai-rewrite'
  | 'raw-key';

/**
 * Discriminated payload map. Keyed by `IntentKind`; each entry is the
 * shape that flows through the router for that kind. Exported so tests
 * and gate authors can construct intents with strong typing.
 */
export interface IntentPayloadMap {
  'execute': { readonly text: string };
  /** Like `execute` but skips alias rewriting — used by replay/macros. */
  'execute-raw': { readonly text: string };
  'interrupt': Record<string, never>;
  'suspend': Record<string, never>;
  'cancel-run': { readonly runId: string };
  'history-search': { readonly query: string };
  'navigate': { readonly direction: 'up' | 'down' | 'prev' | 'next' };
  'inspect-run': { readonly runId: string };
  'copy-output': { readonly runId: string; readonly includeCommand?: boolean };
  'paste': { readonly text: string };
  'rerun': { readonly runId: string };
  'compare-runs': { readonly runIdA: string; readonly runIdB: string };
  'open-path': { readonly path: string };
  'ai-explain': { readonly runId: string };
  'ai-rewrite': { readonly text: string; readonly goal?: string };
  'raw-key': {
    readonly key: string;
    readonly modifiers: {
      readonly ctrl: boolean;
      readonly alt: boolean;
      readonly shift: boolean;
      readonly meta: boolean;
    };
  };
}

export type IntentPayload<K extends IntentKind> = IntentPayloadMap[K];

export type IntentSource =
  | 'user-keystroke'
  | 'user-click'
  | 'palette'
  | 'agent'
  | 'replay'
  | 'macro';

/**
 * The generic `Intent<K>` is narrowable to a specific payload via the
 * `kind` discriminant.  When carrying a collection of arbitrary intents
 * use `AnyIntent` below.
 */
export interface Intent<K extends IntentKind = IntentKind> {
  readonly kind: K;
  readonly payload: IntentPayload<K>;
  readonly source: IntentSource;
  /** 0..1 confidence. User = 1.0, agent default = 0.7. */
  readonly confidence: number;
  /** Monotonic ts (performance.now() preferred, Date.now() fallback). */
  readonly originatingTs: number;
}

export type AnyIntent = {
  [K in IntentKind]: Intent<K>;
}[IntentKind];

/**
 * Decision returned by the gate phase. `confirm` is deliberately a
 * third state (rather than a promise of allow/deny) so a synchronous
 * gate can say "prompt the user" without blocking the hot path; the
 * router coordinates the prompt elsewhere.
 */
export type GateDecision = 'allow' | 'deny' | 'confirm';
