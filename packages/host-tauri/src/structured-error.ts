/**
 * Structured IPC error parsing for the Tauri host bridge (FIX 2, P1).
 *
 * The Rust side returns `Result<T, TauriError>`; Tauri serializes the `Err`
 * variant as `{ code: "session-not-found", user_message: "…", context: {…} }`.
 * `invokeStructured` parses that shape and throws a `HostBridgeErrorThrown`
 * whose `.code` is a typed union the UI can switch on.
 *
 * Backwards-compat: when the Rust side returns a bare string (legacy command
 * that hasn't been migrated), we log a warning and wrap it as
 * `{ code: 'unknown', userMessage: <string> }` so the UI still has a code to
 * branch on.
 */

import { invoke } from '@tauri-apps/api/core';
import type { HostBridgeError, HostBridgeErrorCode } from '@quanta/host-common';

/**
 * Closed list of codes the Rust side emits. Kept in sync with the TS
 * `HostBridgeErrorCode` union in `@quanta/host-common/src/bridge.ts` AND
 * the Rust `ErrorCode` enum in `packages/host-tauri/src-tauri/src/error.rs`.
 * A three-way drift between these three definitions is the single thing this
 * constant catches at runtime — an unknown code from Rust falls through to
 * the UI as `unknown` after logging a warning.
 */
export const KNOWN_HOST_BRIDGE_ERROR_CODES: readonly HostBridgeErrorCode[] = [
  'session-not-found',
  'session-unresponsive',
  'editor-not-found',
  'editor-invalid-path',
  'shell-integration-outside-home',
  'shell-integration-missing',
  'ai-suggest-auth-failed',
  'ai-suggest-rate-limited',
  'ai-suggest-network',
  'ai-suggest-timeout',
  'sidecar-unavailable',
  'bridge-internal',
  'unknown',
];

/**
 * Error class thrown by every typed invoke wrapper. Extends the platform
 * `Error` so existing `try { … } catch (err) { err.message }` sites keep
 * working; new code should prefer switching on `.code`.
 */
export class HostBridgeErrorThrown extends Error {
  public readonly code: HostBridgeErrorCode;
  public readonly userMessage: string;
  public readonly context?: Readonly<Record<string, unknown>>;

  constructor(error: HostBridgeError) {
    super(error.userMessage);
    // Standard `name` so `err instanceof HostBridgeErrorThrown` works across
    // module boundaries (some bundlers re-anchor instanceof to the module
    // that imported the class first — the name check is a durable fallback).
    this.name = 'HostBridgeErrorThrown';
    this.code = error.code;
    this.userMessage = error.userMessage;
    if (error.context) {
      this.context = error.context;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Parse a raw invoke rejection into a `HostBridgeError`. The Rust side emits
 * snake_case (`user_message`); we remap to camelCase to match the TS type.
 * Unknown shapes (bare string, plain Error, arbitrary object) collapse to
 * `{ code: 'unknown', userMessage: <best-effort text> }` after a console.warn
 * so the regression shows up in dev tools without crashing the UI.
 */
export function parseHostBridgeError(raw: unknown): HostBridgeError {
  // Structured shape: Rust `TauriError` serialized as-is.
  if (isRecord(raw) && typeof raw.code === 'string' && typeof raw.user_message === 'string') {
    const code = raw.code as string;
    const known = (KNOWN_HOST_BRIDGE_ERROR_CODES as readonly string[]).includes(code);
    if (!known) {
      // The code is a stable contract between Rust and TS — an unknown value
      // means the two sides drifted. Log loudly so the mismatch is visible
      // in the dev console, but still surface the UI-safe user message.
      // eslint-disable-next-line no-console
      console.warn('[host-tauri] unknown HostBridgeErrorCode from Rust:', code);
    }
    const err: HostBridgeError = {
      code: known ? (code as HostBridgeErrorCode) : 'unknown',
      userMessage: raw.user_message,
    };
    if (isRecord(raw.context)) {
      return { ...err, context: raw.context };
    }
    return err;
  }

  // Legacy bare-string path: the Rust command hasn't been migrated yet, or
  // the Tauri runtime itself emitted a generic `InvokeError::from(String)`
  // before our commands' handlers ran. Wrap as `unknown` with a warning.
  if (typeof raw === 'string') {
    // eslint-disable-next-line no-console
    console.warn(
      '[host-tauri] legacy bare-string bridge error (Rust command not migrated to TauriError):',
      raw,
    );
    return { code: 'unknown', userMessage: raw };
  }

  if (raw instanceof Error) {
    return { code: 'unknown', userMessage: raw.message };
  }

  // Anything else — arbitrary object, undefined, number — stringify best-effort.
  let userMessage: string;
  try {
    userMessage = JSON.stringify(raw);
  } catch {
    userMessage = String(raw);
  }
  // eslint-disable-next-line no-console
  console.warn('[host-tauri] bridge error had unrecognised shape:', raw);
  return { code: 'unknown', userMessage };
}

/**
 * Thin typed wrapper around `invoke` that throws `HostBridgeErrorThrown`
 * on rejection. Every Tauri command on the bridge goes through this so the
 * UI sees a uniform `.code`-switchable surface.
 */
export async function invokeStructured<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw new HostBridgeErrorThrown(parseHostBridgeError(err));
  }
}
