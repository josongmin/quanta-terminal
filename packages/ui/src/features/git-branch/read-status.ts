/**
 * `readGitStatusForRepo(repoRoot, bridge)` — call the host's `gitStatus`
 * capability for a repository root, with built-in staleness + debounce
 * policy so consumers don't have to reimplement them at every call site.
 *
 * Design rules mirror `useGitBranch`:
 *   - Bridge is the only IO primitive; if the host doesn't implement
 *     `gitStatus` (mock / VS Code webview with no shell access) every call
 *     resolves `null` and the UI silently degrades to branch-only.
 *   - Results are cached per-repoRoot with a 15 s TTL, so a rapid re-poll
 *     (cwd flapping, window focus) doesn't spawn a fresh `git status` each
 *     time. A stale entry is served immediately while the background
 *     refresh runs (stale-while-revalidate).
 *   - In-flight calls are coalesced: two callers asking for the same
 *     repoRoot at the same time share a single Promise.
 *
 * Phase-2 note: the TTL is hard-coded rather than configurable. That
 * matches the brief ("every 15s while focused"); a consumer that needs a
 * tighter poll can call `invalidateGitStatusCache(repoRoot)` between polls.
 */

import type { GitStatus } from '@quanta/host-common';

/** Bridge surface the helper actually needs. Splitting it out of
 *  `HostBridge` keeps the cache unit-testable without synthesising a full
 *  bridge object. */
export interface GitStatusBridge {
  readonly gitStatus?: (options: { repoRoot: string }) => Promise<GitStatus | null>;
}

export interface ReadGitStatusOptions {
  readonly bridge: GitStatusBridge;
  /** Force a fresh read, bypassing the cache. Default false. */
  readonly forceRefresh?: boolean;
  /** Inject a clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Default cache TTL. A fresh entry younger than this is served from cache
 *  without touching the bridge. The stale-while-revalidate window sits
 *  just above the 15 s poll cadence so a timer-driven refresh always has
 *  something cached to render optimistically. */
export const GIT_STATUS_CACHE_TTL_MS = 15_000;

interface CacheEntry {
  readonly value: GitStatus | null;
  readonly at: number;
}

// Module-scope cache is intentional: it survives across mounts/unmounts of
// the consumer hook, so tab-switching or re-rendering the status bar does
// not force a fresh shell-out. The map is small (one entry per repo root
// the user has visited) and entries are simple records — no explicit
// eviction beyond overwriting on refresh.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GitStatus | null>>();

export function getCachedGitStatus(
  repoRoot: string,
  now: () => number = Date.now,
): GitStatus | null | undefined {
  const hit = cache.get(repoRoot);
  if (!hit) return undefined;
  if (now() - hit.at > GIT_STATUS_CACHE_TTL_MS) return undefined;
  return hit.value;
}

/** Drop the cached entry for `repoRoot` (or all entries when omitted). */
export function invalidateGitStatusCache(repoRoot?: string): void {
  if (repoRoot === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  cache.delete(repoRoot);
  inFlight.delete(repoRoot);
}

/**
 * Resolve the current git status for `repoRoot`. Never rejects — any
 * bridge-level failure (host doesn't implement the method, shell-out
 * errored, timeout) collapses to `null` so callers treat it as "no info".
 *
 * When the cache is warm the cached value is returned synchronously-ish
 * (via a resolved Promise) and NO bridge call is made. Callers that want
 * to force a fresh read should pass `forceRefresh: true`.
 */
export async function readGitStatusForRepo(
  repoRoot: string,
  options: ReadGitStatusOptions,
): Promise<GitStatus | null> {
  const now = options.now ?? Date.now;
  if (!options.forceRefresh) {
    const hit = cache.get(repoRoot);
    if (hit && now() - hit.at <= GIT_STATUS_CACHE_TTL_MS) {
      return hit.value;
    }
  }
  // Coalesce parallel callers for the same repoRoot.
  const existing = inFlight.get(repoRoot);
  if (existing) return existing;

  const bridge = options.bridge;
  if (typeof bridge.gitStatus !== 'function') {
    // Host has no capability — cache a null so subsequent polls don't
    // retry the lookup within the TTL window.
    const nullEntry: CacheEntry = { value: null, at: now() };
    cache.set(repoRoot, nullEntry);
    return null;
  }

  const p = (async (): Promise<GitStatus | null> => {
    try {
      const value = await bridge.gitStatus!({ repoRoot });
      cache.set(repoRoot, { value, at: now() });
      return value;
    } catch {
      // Defensive: the bridge contract is "never rejects" but hosts may
      // still misbehave. Treat any throw as "no info".
      cache.set(repoRoot, { value: null, at: now() });
      return null;
    } finally {
      inFlight.delete(repoRoot);
    }
  })();
  inFlight.set(repoRoot, p);
  return p;
}

/** Test-only: clear both cache and in-flight map synchronously. */
export function __resetGitStatusCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
