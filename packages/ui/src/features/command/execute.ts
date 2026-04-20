/**
 * `submitCommand` — the single dispatch path that turns a user submission
 * into (1) a new block in the block store, (2) bytes on the PTY.
 *
 * Terminology
 * -----------
 * The canonical verb for the user-intent action is "submit". The composer
 * widget's outer facade is also `submitCommand` (see features/composer);
 * that outer function normalizes composer-specific state (mode, history)
 * before delegating here. Historical callers used `executeCommand`; that
 * name is gone — there is one verb per concept.
 *
 * Why this is its own feature rather than a helper on the composer:
 *
 *   - Other surfaces (command palette rerun, history retry, intent
 *     suggestions) will want to submit a command without going through the
 *     composer UI. They all funnel through this module.
 *   - Command boundary concerns (cancel-previous-on-new-submit, open block
 *     BEFORE writing bytes) live in one place. Duplicating that in every
 *     caller would drift.
 *
 * Ordering invariant
 * ------------------
 * The block is created BEFORE the bridge write. Some bridges (notably the
 * browser-mode mock) emit `pty_data` synchronously inside `write()`. If we
 * wrote first and stashed the block id second, the output router would see
 * bytes with no active block and drop them. `startBlock` is atomic:
 * cancel-previous + create + set-active in one state mutation. This closes
 * the race without any buffering.
 *
 * Return type is a discriminated union rather than a throw — the composer
 * (and any other caller) can render the failure mode declaratively.
 */

import type { HostBridge } from '@quanta/host-common';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { useSessionStore } from '../../entities/session/index.js';
import type { BlockId } from '../../shared/types/generated/index.js';
import { tryGetBlockStore } from './block-store-port.js';
// FIXME(fsd-layer-skip): the command feature consults the degraded gate so
// the single production write path honors RFC §20 ("input disabled during
// degraded state"). The gate is a narrow port; only the TerminalPage orchestrator
// binds it, so the command slice stays decoupled from the degraded-mode UI.
import { tryGetDegradedGate } from '../degraded-mode/degraded-gate.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('command.submit');

export interface SubmitCommandOptions {
  /** Raw command text as typed by the user. */
  readonly text: string;
  /** Current working directory to stamp on the block. Defaults to the
   *  session store's cwd when omitted. */
  readonly cwd?: string;
  /** Override the bridge (tests). Defaults to the installed host bridge. */
  readonly bridge?: HostBridge;
  /** Watchdog timeout in ms. Forwarded to the block store's `startBlock`. */
  readonly watchdogMs?: number;
  /**
   * Rerun lineage pointer (Phase 4). When `rerunBlock` replays an older
   * block's command, this carries the predecessor id so the new block is
   * stamped with `rerunOfId` atomically at creation. Forwarded directly to
   * the block-store port.
   */
  readonly rerunOf?: string | null;
}

export type SubmitCommandResult =
  | { readonly ok: true; readonly blockId: BlockId }
  | {
      readonly ok: false;
      readonly reason: 'no-session' | 'no-bridge' | 'empty' | 'degraded';
      readonly error?: Error;
    }
  | {
      // Bridge accepted the block but threw on write. We keep the block and
      // mark it errored so the user sees the failure attached to the command
      // they typed, not as a floating toast.
      readonly ok: false;
      readonly reason: 'write-failed';
      readonly blockId: BlockId;
      readonly error: Error;
    };

/**
 * Create a block, send the command to the PTY, and make the new block the
 * active output target. Returns a result object; never throws.
 */
export async function submitCommand(
  options: SubmitCommandOptions,
): Promise<SubmitCommandResult> {
  const normalized = options.text.replace(/\r\n/gu, '\n');
  if (normalized.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const bridge = options.bridge ?? tryGetHostBridge();
  if (!bridge) {
    return { ok: false, reason: 'no-bridge' };
  }

  const sessionState = useSessionStore.getState();
  const sessionId = sessionState.id;
  if (sessionId === null) {
    return { ok: false, reason: 'no-session' };
  }

  // RFC §20 / ADR 0010: while the engine is degraded, user input must not
  // reach the PTY. We drop the bytes and bump the telemetry counter so
  // `droppedInputs` becomes observable in the debug panel. The check runs
  // BEFORE `startBlock` so we never leave a half-open block around.
  const gate = tryGetDegradedGate();
  if (gate?.isDegraded()) {
    gate.reportDroppedInput();
    log.debug('submit dropped: session is degraded');
    return { ok: false, reason: 'degraded' };
  }

  const blockStore = tryGetBlockStore();
  if (!blockStore) {
    // Degraded path: nobody bound a block adapter (e.g. test bench for the
    // composer widget, or host bootstrapping hasn't finished). We still
    // honor the submission by writing to the bridge, but there is no block
    // to stash. The synthetic block id is surfaced so the caller can at
    // least key its own UI state if it wants; it never refers to a real
    // block in any store.
    log.debug('submitting without a bound block store; no block created');
    const payload = normalized.endsWith('\n') ? normalized : normalized + '\n';
    try {
      await bridge.write(sessionId, payload);
      return { ok: true, blockId: '' as BlockId };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { ok: false, reason: 'write-failed', blockId: '' as BlockId, error };
    }
  }

  // OPEN THE BLOCK FIRST. startBlock is atomic — it cancels any previously-
  // active block, creates the new one, and sets the active pointer in one
  // state mutation so synchronous pty_data cannot race.
  const cwd = options.cwd ?? sessionState.cwd;
  // Phase 4 — stamp the active session id on the block so BlockList can
  // filter to the currently-visible tab. `watchdogMs` stays optional; we
  // assemble the options object conditionally so a call with neither field
  // still passes `undefined` (preserving the pre-Phase-4 defaults path).
  const startOptions: {
    watchdogMs?: number;
    sessionId?: typeof sessionId;
    rerunOf?: string | null;
  } = {};
  if (options.watchdogMs !== undefined) startOptions.watchdogMs = options.watchdogMs;
  startOptions.sessionId = sessionId;
  if (options.rerunOf !== undefined) startOptions.rerunOf = options.rerunOf;
  const blockId = blockStore.startBlock(normalized, cwd, startOptions);

  // Append newline if the user hasn't already, so the pty treats it as a
  // complete command.
  const payload = normalized.endsWith('\n') ? normalized : normalized + '\n';

  try {
    await bridge.write(sessionId, payload);
    return { ok: true, blockId };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Detach the pointer and mark the block errored — no more output will
    // arrive for this block, and we don't want a subsequent spurious
    // pty_data to land on a failed block.
    blockStore.errorBlock(blockId, `bridge.write failed: ${error.message}`);
    return { ok: false, reason: 'write-failed', blockId, error };
  }
}
