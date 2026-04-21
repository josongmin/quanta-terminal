/**
 * Intent layer — Plan 0005 P2-B.
 *
 * Public surface: types, router factory, built-in gates/rewriters/encoder.
 * Flag-gated behind `flag.intentLayer`; the router is inert when the flag
 * is off and no subscribers are attached.
 */

export type {
  AnyIntent,
  GateDecision,
  Intent,
  IntentKind,
  IntentPayload,
  IntentPayloadMap,
  IntentSource,
} from './intent-types';

export type {
  DispatchResult,
  EncodeFn,
  GateFn,
  InspectFn,
  IntentRouter,
  IntentRouterOptions,
  RewriteFn,
} from './intent-router';
export { createIntentRouter, makeIntent } from './intent-router';

export type { DangerPattern, SafetyGateOptions } from './built-in/safety-gate';
export { createSafetyGate, DEFAULT_DANGER_PATTERNS } from './built-in/safety-gate';

export type { AliasRewriterOptions } from './built-in/alias-rewriter';
export {
  ALIAS_STORAGE_KEY,
  createAliasRewriter,
  DEFAULT_ALIASES,
  readPersistedAliases,
  writePersistedAliases,
} from './built-in/alias-rewriter';

export type { DefaultEncoderOptions } from './built-in/default-encoder';
export { createDefaultEncoder } from './built-in/default-encoder';
