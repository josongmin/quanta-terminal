/**
 * Composer submit — sends composer text to the host PTY.
 *
 * Why a feature instead of inlining the bridge call in the widget:
 *   - the widget stays presentational and can be unit-tested with no bridge;
 *   - the dispatch is the right place to enforce "shell" vs "intent" routing
 *     once the intent layer lands (Phase 2). Today every submit is shell-mode
 *     and appends a newline so the pty sees a complete line.
 *   - history (the "recent commands" scaffold in the widget) needs one place
 *     to be told about submits; this module owns that broadcast.
 *
 * Relationship with features/command
 * ----------------------------------
 * `features/command` owns the canonical submit dispatcher — the one that
 * creates a block and writes to the bridge atomically. This file is a thin
 * composer-local facade that (a) normalizes composer text, (b) delegates
 * to the canonical submit, (c) returns the composer-shaped result that the
 * widget already knows how to render. One verb per concept; the outer name
 * is kept because widgets call `submitCommand` and breaking that would
 * churn widget code outside this agent's scope.
 *
 * Contract:
 *   - Called with a raw string (what the user typed). Trailing newlines are
 *     normalized to a single \n.
 *   - Returns the promise that resolves when the pty accepted the bytes.
 *   - Never throws synchronously; bridge errors reject the returned promise
 *     so the caller can show a toast or roll back the local echo later.
 */

import type { HostBridge } from '@quanta/host-common';
// Cross-slice: the composer submit facade delegates the actual block-create +
// bridge-write atomic dispatch to `features/command`. Both slices live under
// `features/`; crossing is necessary because the one-command-per-submit
// invariant is owned by the command slice, not the composer.
// FIXME(fsd-layer-skip): composer delegates dispatch to the command submit facade
import { submitCommand as submitThroughCommandFeature } from '../command/index.js';

export type ComposerMode = 'shell' | 'intent' | 'auto';

export interface SubmitOptions {
  readonly text: string;
  readonly mode?: ComposerMode;
  /** Override the bridge (tests). Defaults to the installed host bridge. */
  readonly bridge?: HostBridge;
  /**
   * Rerun lineage pointer (Phase 4). Forwarded to the command submit path;
   * the composer widget itself never sets this — it's plumbing for the
   * `rerunBlock` dispatcher so the new block's `rerunOfId` is stamped in
   * the same atomic `startBlock` call.
   */
  readonly rerunOf?: string | null;
}

export interface SubmitResult {
  readonly ok: boolean;
  readonly reason?: 'no-session' | 'no-bridge' | 'empty' | 'degraded';
  readonly error?: Error;
}

/**
 * Send composer text. Returns a result object rather than throwing so the
 * widget can render the submission state declaratively without a try/catch.
 */
export async function submitCommand(options: SubmitOptions): Promise<SubmitResult> {
  const result = await submitThroughCommandFeature({
    text: options.text,
    ...(options.bridge !== undefined ? { bridge: options.bridge } : {}),
    ...(options.rerunOf !== undefined ? { rerunOf: options.rerunOf } : {}),
  });
  if (result.ok) return { ok: true };
  if (result.reason === 'write-failed') {
    return { ok: false, error: result.error };
  }
  return { ok: false, reason: result.reason };
}
