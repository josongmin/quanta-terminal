/**
 * Session-side shell-integration auto-install (Plan 0005 P1-B).
 *
 * Invoked fire-and-forget by `connectSession` after a successful spawn.
 * Owns three concerns that do NOT belong on the hot spawn path:
 *
 *   1. Feature-flag gate (`shellIntegrationAutoInstall`, default on).
 *   2. Back-off: a failed attempt records `failCount` + `lastAttemptAt` in
 *      localStorage under `quanta:shell-install:<shell>`. After 3 consecutive
 *      failures we skip auto-install for 24 h; a successful
 *      `installed` / `already_installed` outcome clears the counter.
 *   3. Toast/UX: `installed` surfaces a "reload your shell" toast,
 *      `already_installed` + `skipped_unsupported_shell` are silent, and
 *      `failed` raises a danger toast that deep-links to the wizard.
 *
 * Pure in the sense that every dependency (bridge, clock, storage, toast) is
 * injectable so tests don't need to mock `localStorage` or `setTimeout`.
 */

import type { HostBridge, ShellInstallOutcome } from '@quanta/host-common';
import { createLogger } from '../../shared/lib/logger.js';
import { getFeatureFlag } from '../../shared/config/feature-flags.js';
import { showToast } from '../../shared/ui/toast/toast-store.js';

const log = createLogger('session.shell-install');

/** Maximum consecutive failures before we stop retrying for 24 h. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Cool-down window after hitting {@link MAX_CONSECUTIVE_FAILURES}. */
export const BACKOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** localStorage key prefix. The shell discriminant is appended verbatim. */
export const BACKOFF_STORAGE_PREFIX = 'quanta:shell-install:';

/** Shape persisted in localStorage. JSON-serializable. */
export interface BackoffRecord {
  readonly lastAttemptAt: number;
  readonly failCount: number;
}

/**
 * Abstract storage so tests can inject an in-memory map. Browser / Tauri
 * both hand us `localStorage` which already matches this shape.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Optional deep-link hook used by the "Learn more" action in the failure
 *  toast. Keeps this module decoupled from the wizard widget — callers
 *  (`main.tsx`) wire the actual open-wizard action in. */
export type OpenWizardHook = (shell: string) => void;

export interface AutoInstallDeps {
  readonly bridge: Pick<HostBridge, 'shellInstallAuto'>;
  readonly storage?: KeyValueStorage | null;
  readonly now?: () => number;
  readonly toast?: typeof showToast;
  readonly openWizard?: OpenWizardHook;
  /**
   * Bypass the 3-strike / 24h back-off gate when `true`. The default is
   * `false` which preserves the auto-install policy (fire-and-forget from
   * `connectSession`). An explicit user-driven re-install — the wizard's
   * "Install now" button, a `/reinstall-shell` command palette action, or a
   * debug flag flip — passes `force: true` to skip the back-off read and
   * attempt the install unconditionally. Back-off bookkeeping on the
   * outcome (increment on failure, clear on success) still runs — `force`
   * only suppresses the pre-call gate, so a user who hits "install now"
   * three times in a row still ends up in back-off after the third failure.
   */
  readonly force?: boolean;
}

/**
 * Shell-string normaliser. The bridge accepts the raw `spawn.shell` value
 * (which may be `/bin/zsh`, `/usr/local/bin/fish`, etc.), but the back-off
 * bucket keys on the shell family to keep retry counters coherent across
 * sessions.
 */
export function shellFamily(shell: string): string {
  const lastSlash = shell.lastIndexOf('/');
  const leaf = lastSlash >= 0 ? shell.slice(lastSlash + 1) : shell;
  return leaf.toLowerCase();
}

/** Read-through accessor. Tolerant of malformed values (returns null). */
export function readBackoff(
  storage: KeyValueStorage,
  shell: string,
): BackoffRecord | null {
  try {
    const raw = storage.getItem(BACKOFF_STORAGE_PREFIX + shellFamily(shell));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    const lastAttemptAt = typeof rec.lastAttemptAt === 'number' ? rec.lastAttemptAt : 0;
    const failCount = typeof rec.failCount === 'number' ? rec.failCount : 0;
    return { lastAttemptAt, failCount };
  } catch {
    return null;
  }
}

export function writeBackoff(
  storage: KeyValueStorage,
  shell: string,
  record: BackoffRecord,
): void {
  try {
    storage.setItem(
      BACKOFF_STORAGE_PREFIX + shellFamily(shell),
      JSON.stringify(record),
    );
  } catch {
    // Private-mode / quota — fire-and-forget write.
  }
}

export function clearBackoff(storage: KeyValueStorage, shell: string): void {
  try {
    storage.removeItem(BACKOFF_STORAGE_PREFIX + shellFamily(shell));
  } catch {
    // ignore
  }
}

/**
 * Returns true when the caller should skip the auto-install attempt for this
 * shell. A back-off applies iff the most recent run failed at least
 * {@link MAX_CONSECUTIVE_FAILURES} times in a row AND the last attempt was
 * within the {@link BACKOFF_WINDOW_MS} cool-down window.
 */
export function isInBackoff(
  record: BackoffRecord | null,
  now: number,
): boolean {
  if (record === null) return false;
  if (record.failCount < MAX_CONSECUTIVE_FAILURES) return false;
  return now - record.lastAttemptAt < BACKOFF_WINDOW_MS;
}

/** Resolve the default storage — `localStorage` in the browser, `null` in
 *  environments where storage is unavailable (private mode, tests). */
function defaultStorage(): KeyValueStorage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    // Quick probe: a synchronous getItem call confirms the API is callable.
    localStorage.getItem(BACKOFF_STORAGE_PREFIX + '__probe');
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Entry point. Fire-and-forget from `connectSession`; never throws. Safe to
 * call on every spawn — the feature flag + back-off guard short-circuit
 * before we touch the bridge.
 */
export async function maybeAutoInstallShellIntegration(
  shell: string,
  deps: AutoInstallDeps,
): Promise<ShellInstallOutcome | null> {
  // Flag gate. The flag default is `true`; an explicit opt-out disables this
  // path entirely (no back-off probe, no bridge call).
  if (!getFeatureFlag('shellIntegrationAutoInstall')) {
    log.debug('skipped: flag off', shell);
    return null;
  }

  // Some adapters (mock bridge, VS Code) don't implement the method. Treat
  // that as a silent skip — there is nothing to install.
  const installAuto = deps.bridge.shellInstallAuto?.bind(deps.bridge);
  if (!installAuto) {
    log.debug('skipped: bridge has no shellInstallAuto', shell);
    return null;
  }

  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = (deps.now ?? Date.now)();
  const force = deps.force === true;

  // Back-off gate — skipped entirely when `force === true`. The bookkeeping
  // below still runs on the outcome so a forced retry that fails can
  // eventually re-enter back-off if the user keeps hammering the button.
  if (storage && !force) {
    const existing = readBackoff(storage, shell);
    if (isInBackoff(existing, now)) {
      log.debug('skipped: back-off active', shell, existing);
      return null;
    }
  }

  let outcome: ShellInstallOutcome;
  try {
    outcome = await installAuto(shell);
  } catch (err) {
    // The bridge contract normalises failures into `kind: 'failed'`, but
    // defensive: an adapter that rejects still ends up here.
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', reason };
  }

  // Back-off bookkeeping. `installed` / `already_installed` clear the
  // counter; `failed` increments it; `skipped_unsupported_shell` is a
  // no-op (retry could never succeed — we don't want to consume the
  // back-off budget for a permanent skip).
  if (storage) {
    switch (outcome.kind) {
      case 'installed':
      case 'already_installed':
        clearBackoff(storage, shell);
        break;
      case 'failed': {
        const existing = readBackoff(storage, shell);
        writeBackoff(storage, shell, {
          lastAttemptAt: now,
          failCount: (existing?.failCount ?? 0) + 1,
        });
        break;
      }
      case 'skipped_unsupported_shell':
        // Intentional no-op — see comment above.
        break;
    }
  }

  // Toast + deep-link surface.
  const toast = deps.toast ?? showToast;
  switch (outcome.kind) {
    case 'installed':
      toast({
        kind: 'info',
        message:
          'Shell integration installed. Reload your shell or open a new session.',
      });
      log.info('installed', shell, outcome.rcPath);
      break;
    case 'already_installed':
      // Silent — user already has the snippet, nothing to announce.
      log.debug('already installed', shell);
      break;
    case 'skipped_unsupported_shell':
      // Silent — auto-install is shell-specific; unsupported shells have
      // no actionable surface.
      log.debug('unsupported shell, skipped', shell);
      break;
    case 'failed': {
      toast({
        kind: 'warning',
        message:
          'Quanta could not install shell integration automatically. Click to open the wizard.',
      });
      // Fire the wizard hook after a short delay so the toast renders
      // before we yank attention into the wizard. The delay is advisory,
      // not observable from tests (we pass openWizard explicitly).
      if (deps.openWizard) {
        deps.openWizard(shell);
      }
      log.warn('failed', shell, outcome.reason);
      break;
    }
  }

  return outcome;
}
