/**
 * Shell-integration wizard — install orchestration.
 *
 * Owns the two-phase dance against the host bridge:
 *   1. `preview(shell)` — calls `installShellIntegration({shell, confirm:false})`
 *      to fetch the snippet the host would append. Never mutates.
 *   2. `install(shell)` — calls with `confirm:true`, returning the mutation
 *      result or re-surfacing an already-installed reply.
 *
 * The wizard UI calls these helpers directly; the banner calls `preview` to
 * decorate its tooltip (e.g. "installs into ~/.zshrc") before the user opens
 * the modal.
 *
 * Telemetry: logs action + outcome at info level through the per-scope
 * logger. Errors are logged at warn.
 */

import type {
  InstallShellIntegrationReply,
  ShellKind,
} from '@quanta/host-common';
import { getHostBridge } from '../../shared/api/host-bridge.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('shell-integration.wizard');

export interface PreviewOutcome {
  readonly kind: 'preview';
  readonly reply: InstallShellIntegrationReply;
}

export interface InstalledOutcome {
  readonly kind: 'installed';
  readonly reply: InstallShellIntegrationReply;
}

export interface AlreadyInstalledOutcome {
  readonly kind: 'already-installed';
  readonly reply: InstallShellIntegrationReply;
}

export interface ErrorOutcome {
  readonly kind: 'error';
  readonly message: string;
}

export type InstallActionOutcome = InstalledOutcome | AlreadyInstalledOutcome | ErrorOutcome;

/**
 * Fetch the preview. `confirm` is always `false` here — callers MUST use
 * `install()` below to actually mutate the dotfile.
 */
export async function preview(shell: ShellKind): Promise<PreviewOutcome | ErrorOutcome> {
  log.info('preview', { shell });
  try {
    const bridge = getHostBridge();
    const reply = await bridge.installShellIntegration({ shell, confirm: false });
    return { kind: 'preview', reply };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('preview failed', { shell, message });
    return { kind: 'error', message };
  }
}

/**
 * Commit the install. Requires an explicit boolean `userConfirmed` — this is
 * the last gate between the wizard's Confirm button and the host command.
 * Opening the wizard or stepping past preview does NOT count as consent; the
 * modal must call this helper with a `true` argument from the Confirm click
 * handler.
 */
export async function install(
  shell: ShellKind,
  userConfirmed: boolean,
): Promise<InstallActionOutcome> {
  if (!userConfirmed) {
    // Defensive: the wizard SHOULD never call this with false, but if a
    // future refactor does we must refuse rather than silently running the
    // preview (which the typed-to-confirm contract forbids).
    log.warn('install called without userConfirmed=true; refusing');
    return { kind: 'error', message: 'install: user consent was not captured' };
  }
  log.info('install confirmed', { shell });
  try {
    const bridge = getHostBridge();
    const reply = await bridge.installShellIntegration({ shell, confirm: true });
    if (reply.alreadyInstalled && !reply.mutated) {
      log.info('already installed; no-op', { shell, targetPath: reply.targetPath });
      return { kind: 'already-installed', reply };
    }
    log.info('installed', {
      shell,
      targetPath: reply.targetPath,
      lineCount: reply.lineCount,
    });
    return { kind: 'installed', reply };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('install failed', { shell, message });
    return { kind: 'error', message };
  }
}

/**
 * Compose a short, human-friendly summary of the snippet length. Used by the
 * banner tooltip and the wizard header. Counts only the script body (not the
 * guard header/footer lines) for honesty — "append 72 lines" is what the
 * user cares about, not the two-line sentinel.
 */
export function countSnippetLines(snippet: string): number {
  // Strip the guard markers so the number reflects the actual script body.
  // If the sentinels are missing we fall back to the raw line count so the
  // UI never displays a bogus zero for a valid (but differently formatted)
  // snippet.
  const hasHeader = snippet.includes('# >>> quanta shell integration >>>');
  const hasFooter = snippet.includes('# <<< quanta shell integration <<<');
  const raw = snippet.split('\n').length;
  if (!hasHeader || !hasFooter) return raw;
  // Two guard lines + the leading newline that build_snippet adds.
  return Math.max(0, raw - 3);
}
