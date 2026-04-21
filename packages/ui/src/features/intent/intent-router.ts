/**
 * Intent router — Plan 0005 P2-B.
 *
 * Four-phase dispatch, each phase independently subscribable so a
 * plugin can add a rewriter without reaching into the others:
 *
 *   1. inspect  — observers only. Cannot block the pipeline. Telemetry,
 *                 history-ingest, session-record all attach here.
 *   2. gate     — may return `'deny'` (drop intent) or `'confirm'`
 *                 (prompt). First `'deny'` wins; a `'confirm'` is
 *                 surfaced via the `onConfirm` hook (see below).
 *   3. rewrite  — each rewriter returns a (possibly new) intent or
 *                 `null` to drop. Runs in registration order; the
 *                 returned intent feeds the next rewriter.
 *   4. encode   — final stage. First encoder to return non-null bytes
 *                 wins; the bytes are delivered via the registered
 *                 `onBytes` sink (the input-host wires this).
 *
 * Determinism: subscribers are held in insertion order and dispatched
 * that way. Tests rely on this; do not swap to Set-based iteration.
 *
 * Async confirm: `dispatch()` is `async`. When a gate returns
 * `'confirm'` the router calls the `onConfirm` hook (if wired) and
 * awaits its boolean. If no hook is wired the router is **fail-closed**:
 * the intent resolves as `'confirmed-denied'`. Tests that want to bypass
 * confirmation must explicitly set `allowWithoutConfirmHook: true`.
 */

import type { AnyIntent, GateDecision, Intent, IntentKind } from './intent-types';

export type InspectFn = (intent: AnyIntent) => void;
export type GateFn = (intent: AnyIntent) => GateDecision;
export type RewriteFn = (intent: AnyIntent) => AnyIntent | null;
export type EncodeFn = (intent: AnyIntent) => Uint8Array | null;

export interface IntentRouterOptions {
  /**
   * Bytes sink. Called with the encoder output when an intent makes it
   * all the way through rewrite → encode. The input-host wires this to
   * its `deliverBytes`.
   */
  readonly onBytes?: (bytes: Uint8Array, intent: AnyIntent) => void;
  /**
   * Called when a gate returns `'confirm'`. Returning `false` aborts
   * the intent; returning `true` allows it to continue. If this hook is
   * missing the router is **fail-closed**: `'confirm'` collapses to
   * `'confirmed-denied'` (not to `'allow'`). Tests / headless harnesses
   * that deliberately want to bypass confirmation must set
   * `allowWithoutConfirmHook: true`.
   */
  readonly onConfirm?: (intent: AnyIntent) => boolean | Promise<boolean>;
  /**
   * Explicit escape hatch: when `true`, a `'confirm'` decision with no
   * `onConfirm` hook collapses to `'allow'` (historical, test-only
   * behaviour). The default is `false` so production code that forgets
   * to wire `onConfirm` never accidentally bypasses safety prompts.
   */
  readonly allowWithoutConfirmHook?: boolean;
  /**
   * Called when a gate returns `'deny'`. Informational only — used by
   * the safety-gate UI to surface a toast explaining the denial.
   */
  readonly onDeny?: (intent: AnyIntent, reason?: string) => void;
}

export interface DispatchResult {
  readonly outcome: 'delivered' | 'denied' | 'confirmed-denied' | 'dropped' | 'no-encoder';
  readonly bytes?: Uint8Array;
  readonly finalIntent?: AnyIntent;
}

export interface IntentRouter {
  /** Phase 1: inspect — observers only, cannot block. */
  subscribeInspect(fn: InspectFn): () => void;
  /** Phase 2: gate — may deny or require-confirm. Chain: first 'deny' wins. */
  subscribeGate(fn: GateFn): () => void;
  /** Phase 3: rewrite — may rewrite. Chain: each runs in order; return new intent. */
  subscribeRewrite(fn: RewriteFn): () => void;
  /** Phase 4: encode — final stage, encode to bytes and call onBytesOut. */
  subscribeEncode(fn: EncodeFn): () => void;
  /** Dispatch an intent through the phases. */
  dispatch(intent: AnyIntent): Promise<DispatchResult>;
}

/**
 * Helper to build an `Intent<K>` with the generic routers-accept
 * widening. Most callers use this; direct object literals work too
 * but lose payload type-narrowing.
 */
export function makeIntent<K extends IntentKind>(
  kind: K,
  payload: Intent<K>['payload'],
  opts: {
    source: Intent<K>['source'];
    confidence?: number;
    originatingTs?: number;
  },
): Intent<K> {
  const ts =
    opts.originatingTs ??
    (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now());
  return {
    kind,
    payload,
    source: opts.source,
    confidence: opts.confidence ?? (opts.source === 'user-keystroke' ? 1.0 : 0.7),
    originatingTs: ts,
  };
}

/**
 * Create a router. Subscriptions survive the router's lifetime; the
 * returned unsubscribe functions remove the subscriber in O(n) on the
 * phase's chain (n is small and already iterated on every dispatch,
 * so we trade O(n) removal for deterministic ordering).
 */
export function createIntentRouter(opts: IntentRouterOptions = {}): IntentRouter {
  const inspectors: InspectFn[] = [];
  const gates: GateFn[] = [];
  const rewriters: RewriteFn[] = [];
  const encoders: EncodeFn[] = [];

  function removeFrom<T>(arr: T[], fn: T): void {
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  return {
    subscribeInspect(fn) {
      inspectors.push(fn);
      return () => removeFrom(inspectors, fn);
    },
    subscribeGate(fn) {
      gates.push(fn);
      return () => removeFrom(gates, fn);
    },
    subscribeRewrite(fn) {
      rewriters.push(fn);
      return () => removeFrom(rewriters, fn);
    },
    subscribeEncode(fn) {
      encoders.push(fn);
      return () => removeFrom(encoders, fn);
    },
    async dispatch(intent) {
      // Phase 1 — inspectors. Never block; a throwing inspector is
      // swallowed so one buggy observer cannot break dispatch.
      for (const fn of inspectors.slice()) {
        try {
          fn(intent);
        } catch {
          // swallow — inspectors are observers only
        }
      }

      // Phase 2 — gates. First deny wins; track whether any gate asked
      // for confirmation so the router can prompt AFTER all gates ran
      // (a second gate could still deny outright).
      let needsConfirm = false;
      for (const fn of gates.slice()) {
        let decision: GateDecision;
        try {
          decision = fn(intent);
        } catch {
          // A gate that throws is fail-closed: treat as deny so a buggy
          // safety rule cannot accidentally allow dangerous input.
          opts.onDeny?.(intent, 'gate threw');
          return { outcome: 'denied' };
        }
        if (decision === 'deny') {
          opts.onDeny?.(intent);
          return { outcome: 'denied' };
        }
        if (decision === 'confirm') {
          needsConfirm = true;
        }
      }

      if (needsConfirm) {
        if (opts.onConfirm) {
          let allowed: boolean;
          try {
            const r = opts.onConfirm(intent);
            allowed = typeof r === 'boolean' ? r : await r;
          } catch {
            // Confirm hook threw — treat as denied (fail-closed).
            return { outcome: 'confirmed-denied' };
          }
          if (!allowed) return { outcome: 'confirmed-denied' };
        } else if (!opts.allowWithoutConfirmHook) {
          // No hook wired and no explicit opt-out → fail-closed. A
          // forgotten onConfirm must never silently deliver a payload
          // that a gate asked the user to confirm.
          opts.onDeny?.(intent, 'confirm hook missing');
          return { outcome: 'confirmed-denied' };
        }
      }

      // Phase 3 — rewriters. Each runs in order; a rewriter may drop
      // the intent by returning null.
      let current: AnyIntent | null = intent;
      for (const fn of rewriters.slice()) {
        if (current === null) break;
        try {
          current = fn(current);
        } catch {
          // Rewriter threw — drop the intent (fail-closed). A broken
          // alias map should never silently deliver a raw payload.
          return { outcome: 'dropped' };
        }
      }
      if (current === null) return { outcome: 'dropped' };

      // Phase 4 — encoders. First non-null wins.
      const finalIntent = current;
      for (const fn of encoders.slice()) {
        let bytes: Uint8Array | null;
        try {
          bytes = fn(finalIntent);
        } catch {
          // Encoder threw — try the next encoder. This mirrors the
          // "first non-null wins" contract; a broken encoder falls out
          // of the race rather than killing dispatch.
          continue;
        }
        if (bytes !== null) {
          opts.onBytes?.(bytes, finalIntent);
          return { outcome: 'delivered', bytes, finalIntent };
        }
      }
      return { outcome: 'no-encoder', finalIntent };
    },
  };
}
