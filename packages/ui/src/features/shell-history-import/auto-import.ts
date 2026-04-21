/**
 * Auto-import orchestrator.
 *
 * On first mount of the main app (when {@link useImportedHistoryStore}
 * reports `ranOnce === false`) we try, in order:
 *   1. `~/.zsh_history`
 *   2. `~/.bash_history`
 *   3. `~/.config/fish/fish_history`
 *
 * The first readable file wins — we don't try to merge multiple shells'
 * histories since the user is overwhelmingly on one shell at a time, and
 * the secondary file's entries would be either a strict subset (the user
 * migrated) or stale (the user switched long ago). Picking the zsh file
 * first is a reasonable prior on modern macOS / Linux setups; fish is the
 * last fallback because fish users tend to already have autosuggest via
 * fish's own history and are less starved for this feature.
 *
 * `ranOnce` is set to `true` REGARDLESS of outcome — a second boot doesn't
 * re-scan disks it already scanned. Users who want to re-import click the
 * "Re-import" button in Settings, which calls {@link runImportForce} (the
 * same flow but ignoring the flag).
 *
 * Error handling: every per-file read failure is logged at `warn` and the
 * loop continues. A missing file (readTextFile → null) is a normal
 * outcome, not a failure. Never throws to the caller.
 */

import type { HostBridge } from '@quanta/host-common';
import { createLogger } from '../../shared/lib/logger.js';
import {
  parseBashHistory,
  parseFishHistory,
  parseZshHistory,
  type ShellHistorySource,
} from './parse.js';
import { useImportedHistoryStore } from './import-store.js';

const log = createLogger('shell-history-import');

/**
 * Per-file byte cap. Large enough to cover the overwhelming majority of
 * real users' histories (even shell power-users rarely exceed 256 KiB of
 * zsh_history), and strictly under the bridge's 64 KiB default cap × 8
 * after we pass our own `maxBytes`. We pass 512 KiB explicitly so the
 * Rust side's absolute 64 KiB wall does NOT kick in — that ceiling was
 * designed for `.git/HEAD` style tiny files. We clamp to the same 64 KiB
 * cap for the first draft since changing the Rust cap is out of scope;
 * users with larger files will get a truncated tail which the parser's
 * "tail wins" policy still handles correctly.
 */
const READ_CAP_BYTES = 64 * 1024;

/**
 * Union of arguments needed to run auto-import. The `bridge` is the live
 * host bridge (or a narrowed subset thereof in tests); `now` is an
 * optional clock override so the unit tests can pin `importedAt`.
 */
export interface RunImportArgs {
  readonly bridge: Pick<HostBridge, 'getHomeDir' | 'readTextFile'>;
  readonly now?: number;
}

export interface RunImportResult {
  readonly imported: boolean;
  readonly source: ShellHistorySource | null;
  readonly count: number;
  /** A short human-readable reason when `imported === false` — surfaced
   *  by the Settings panel as a subtle diagnostic line. */
  readonly skipReason?:
    | 'no-bridge-support'
    | 'no-home-dir'
    | 'no-files-readable'
    | 'empty-history';
}

/**
 * Once-per-app auto-import entry point. Returns early (with
 * `imported: false, skipReason: undefined` — the caller should not show
 * anything) when {@link useImportedHistoryStore} reports `ranOnce === true`.
 */
export async function runAutoImport(
  args: RunImportArgs,
): Promise<RunImportResult> {
  const store = useImportedHistoryStore.getState();
  if (store.ranOnce) {
    return { imported: false, source: null, count: 0 };
  }
  return runImportForce(args);
}

/**
 * Force-import entry point used by the Settings "Re-import" button. Same
 * flow as {@link runAutoImport} minus the `ranOnce` short-circuit.
 */
export async function runImportForce(
  args: RunImportArgs,
): Promise<RunImportResult> {
  const { bridge, now } = args;
  // The `ranOnce` flag is flipped before we return — auto-import is
  // "fire once" even on error, to avoid re-prompting.
  const markRan = useImportedHistoryStore.getState().markRan;

  if (typeof bridge.getHomeDir !== 'function') {
    markRan();
    return {
      imported: false,
      source: null,
      count: 0,
      skipReason: 'no-bridge-support',
    };
  }

  let home: string | null;
  try {
    home = await bridge.getHomeDir();
  } catch (err) {
    log.warn('shell-history-import: getHomeDir threw', err);
    home = null;
  }
  if (home === null || home.length === 0) {
    markRan();
    return { imported: false, source: null, count: 0, skipReason: 'no-home-dir' };
  }

  const candidates: ReadonlyArray<{
    readonly source: ShellHistorySource;
    readonly path: string;
    readonly parser: (raw: string) => string[];
  }> = [
    {
      source: 'zsh',
      path: joinPath(home, '.zsh_history'),
      parser: parseZshHistory,
    },
    {
      source: 'bash',
      path: joinPath(home, '.bash_history'),
      parser: parseBashHistory,
    },
    {
      source: 'fish',
      path: joinPath(home, '.config/fish/fish_history'),
      parser: parseFishHistory,
    },
  ];

  let result: RunImportResult | null = null;
  let anyReadable = false;
  for (const candidate of candidates) {
    let raw: string | null;
    try {
      raw = await bridge.readTextFile({
        path: candidate.path,
        maxBytes: READ_CAP_BYTES,
      });
    } catch (err) {
      // Per the bridge contract, a missing file resolves to null — so a
      // rejection here is a real I/O error. Log and try the next file.
      log.warn(
        `shell-history-import: readTextFile rejected for ${candidate.path}`,
        err,
      );
      continue;
    }
    if (raw === null) continue;
    anyReadable = true;
    let parsed: string[];
    try {
      parsed = candidate.parser(raw);
    } catch (err) {
      // Our parsers are designed not to throw, but we keep the guard so a
      // future bug surfaces as a logged warning rather than a crashed UI.
      log.warn(`shell-history-import: ${candidate.source} parser threw`, err);
      continue;
    }
    if (parsed.length === 0) {
      // File existed but carried nothing useful — keep looking in the
      // fallback files rather than declaring victory on a zero import.
      result = {
        imported: false,
        source: null,
        count: 0,
        skipReason: 'empty-history',
      };
      continue;
    }
    const ingestArgs =
      now !== undefined
        ? { entries: parsed, source: candidate.source, now }
        : { entries: parsed, source: candidate.source };
    useImportedHistoryStore.getState().ingest(ingestArgs);
    return {
      imported: true,
      source: candidate.source,
      count: parsed.length,
    };
  }

  markRan();
  if (result !== null) return result;
  return {
    imported: false,
    source: null,
    count: 0,
    skipReason: anyReadable ? 'empty-history' : 'no-files-readable',
  };
}

/**
 * Tiny path join helper. Avoids pulling in a Node `path` dep — the
 * candidates are known-absolute and always POSIX-style on macOS/Linux,
 * which is the only platform shipping Phase 1. Windows support would
 * swap this for a proper adapter.
 */
function joinPath(home: string, rel: string): string {
  const trimmed = home.endsWith('/') ? home.slice(0, -1) : home;
  return `${trimmed}/${rel}`;
}
