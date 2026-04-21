/**
 * Agent action types — Plan 0005 P2-E.
 *
 * These types describe the streaming surface emitted by an
 * `AgentRunner`. They deliberately mirror the shape that a future real
 * AI / tool-call provider will produce so the runner — whether mocked
 * or real — can feed the run overlay without a translation layer in
 * the middle.
 *
 * Mock-vs-real boundary
 * ---------------------
 * The type module is provider-agnostic: both the stub runner landing in
 * this slice AND a later real-AI runner emit `AgentAction`s through the
 * same `AgentRunner.onStream` surface. The runner implementation is the
 * only seam that changes when real tool-calls arrive.
 *
 * Discrimination
 * --------------
 * Every variant is a discriminated union on `kind`. Consumers can narrow
 * with a simple `switch (action.kind)` which TypeScript's strict mode
 * exhaustiveness-checks at compile time.
 *
 * The separation between `tool-call` (initial intent) and
 * `stream-start` / `stream-chunk` / `stream-end` (byte-level stream into
 * the grid) lets the overlay wire the run-row display without decoding
 * tool arguments — chrome is driven by the `AgentRunSpec`, body by the
 * stream chunks.
 */

export type AgentAction =
  | { readonly kind: 'tool-call'; readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'stream-start'; readonly runId: string }
  | { readonly kind: 'stream-chunk'; readonly runId: string; readonly bytes: Uint8Array }
  | { readonly kind: 'stream-end'; readonly runId: string; readonly exitCode: number };

/**
 * Spec used to start an agent run.
 *
 * `type: 'agent'` is pinned so a caller supplying a `Run`-shaped object
 * literal does not mix this up with a future `'shell'` spec. `source`
 * distinguishes runs the UI triggered from an AI suggestion (AI-originated)
 * vs runs the user manually invoked via a palette / slash command.
 *
 * `confidence` is a model-provided 0..1 scalar describing how sure the
 * provider is about the invocation. The mock returns 1.0; a real provider
 * threads its own scalar through.
 */
export interface AgentRunSpec {
  readonly type: 'agent';
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly source: 'ai' | 'user';
  readonly confidence: number;
}

/** Narrow helper — true when the action is a stream-* variant for `runId`. */
export function isStreamActionFor(action: AgentAction, runId: string): boolean {
  switch (action.kind) {
    case 'stream-start':
    case 'stream-chunk':
    case 'stream-end':
      return action.runId === runId;
    default:
      return false;
  }
}

/**
 * Exhaustiveness helper — call `assertNever(action)` in the default
 * branch of a switch to force a compile-time error if a future variant
 * is added without updating the consumer.
 */
export function assertNever(x: never): never {
  throw new Error(`unexpected agent action: ${JSON.stringify(x)}`);
}
