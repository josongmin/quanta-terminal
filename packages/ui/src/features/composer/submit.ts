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
 * Contract:
 *   - Called with a raw string (what the user typed). Trailing newlines are
 *     normalized to a single \n.
 *   - Returns the promise that resolves when the pty accepted the bytes.
 *   - Never throws synchronously; bridge errors reject the returned promise
 *     so the caller can show a toast or roll back the local echo later.
 */

import type { HostBridge } from '@quanta/host-common';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { useSessionStore } from '../../entities/session/index.js';

export type ComposerMode = 'shell' | 'intent' | 'auto';

export interface SubmitOptions {
  readonly text: string;
  readonly mode?: ComposerMode;
  /** Override the bridge (tests). Defaults to the installed host bridge. */
  readonly bridge?: HostBridge;
}

export interface SubmitResult {
  readonly ok: boolean;
  readonly reason?: 'no-session' | 'no-bridge' | 'empty';
  readonly error?: Error;
}

/**
 * Send composer text. Returns a result object rather than throwing so the
 * widget can render the submission state declaratively without a try/catch.
 */
export async function submitCommand(options: SubmitOptions): Promise<SubmitResult> {
  const text = options.text.replace(/\r\n/gu, '\n');
  if (text.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const bridge = options.bridge ?? tryGetHostBridge();
  if (!bridge) {
    return { ok: false, reason: 'no-bridge' };
  }

  const sessionId = useSessionStore.getState().id;
  if (sessionId === null) {
    return { ok: false, reason: 'no-session' };
  }

  // Phase 1: every submit is shell-mode. Append a newline if missing so the
  // pty treats it as a complete command.
  const payload = text.endsWith('\n') ? text : text + '\n';
  try {
    await bridge.write(sessionId, payload);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
