/**
 * `useGitBranch(cwd)` — resolves the git branch for a working directory by
 * walking up to the nearest `.git/HEAD` through the host bridge. When the
 * host also implements `gitStatus` we extend the result with dirty /
 * ahead-behind metadata so the status-bar chip can show `main*` or
 * `main↑2↓1`.
 *
 * Design rules:
 *   - Debounced: rapid cwd changes (e.g. `cd a && cd b && cd c` typed fast)
 *     collapse into one read. Default 150ms.
 *   - Cached: repeated lookups for the same cwd return the cached answer.
 *     The cache is keyed by cwd directly; a tiny LRU keeps it bounded.
 *   - Cancellable: a cwd change in-flight aborts the previous read before
 *     the new one fires. Without this, a slow bridge on the old cwd could
 *     overwrite fresh state with stale data.
 *   - Mock-friendly: the bridge is resolved via `tryGetHostBridge()` so
 *     tests can inject their own without touching `window.__QUANTA_HOST__`.
 *   - Graceful: a host without the `gitStatus` capability still gets the
 *     branch-only path; `dirty`/`ahead`/`behind` stay `null` (UI hides the
 *     decorations). The `readGitStatusForRepo` helper handles the layering.
 *
 * Phase-2 hooks we intentionally leave unimplemented:
 *   - periodic refresh while focused (the brief mentions "every 15s". Today
 *     the hook relies on the cwd-change trigger + the status cache's TTL;
 *     a focus-aware timer is a small follow-up when the UI has one.).
 */

import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '@quanta/host-common';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { GIT_BRANCH_ABSENT, readGitBranchForCwd, type GitBranchInfo } from './read-branch.js';
import { readGitStatusForRepo, type GitStatusBridge } from './read-status.js';

type ReadTextFileFn = (args: { path: string; maxBytes?: number }) => Promise<string | null>;

export interface UseGitBranchOptions {
  /** Debounce delay for rapid cwd changes. Default 150ms. */
  readonly debounceMs?: number;
  /** Test hook: supply a bridge explicitly. Supports both the branch-only
   *  `readTextFile` path and the optional `gitStatus` capability used for
   *  dirty / ahead-behind. */
  readonly bridge?: { readTextFile: ReadTextFileFn } & GitStatusBridge;
  /** Test hook: disable the debounce (useful when tests drive vi's clock). */
  readonly immediate?: boolean;
}

/**
 * Extended branch info — the original `GitBranchInfo` plus the three
 * "Warp prompt" status fields. `null` means "the host did not / could not
 * answer", which the StatusBar renders as "just the branch name".
 */
export interface GitStatusInfo extends GitBranchInfo {
  readonly dirty: boolean | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}

export const GIT_STATUS_ABSENT: GitStatusInfo = {
  ...GIT_BRANCH_ABSENT,
  dirty: null,
  ahead: null,
  behind: null,
};

function withStatus(info: GitBranchInfo, status: GitStatus | null): GitStatusInfo {
  if (!status) {
    return { ...info, dirty: null, ahead: null, behind: null };
  }
  // Prefer git's own branch/detached answer if it's richer: the porcelain
  // output surfaces `(detached)` as `detached: true` without a branch,
  // whereas the HEAD parser has a short sha — keep the short sha from HEAD
  // in that case so the chip has something to render. If branch-from-HEAD
  // is null but git-status has a branch, use git's answer.
  const branch = info.branch ?? status.branch;
  const detached = info.detached || status.detached;
  return {
    branch,
    detached,
    isGitRepo: info.isGitRepo,
    repoRoot: info.repoRoot,
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
  };
}

interface CacheEntry {
  readonly value: GitStatusInfo;
}

const CACHE_MAX = 16;

function useGitBranchCache(): Map<string, CacheEntry> {
  const ref = useRef<Map<string, CacheEntry> | null>(null);
  if (ref.current === null) {
    ref.current = new Map();
  }
  return ref.current;
}

function cacheGet(cache: Map<string, CacheEntry>, key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // LRU: re-insert so it becomes "most recent".
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(cache: Map<string, CacheEntry>, key: string, value: GitStatusInfo): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { value });
  while (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

export function useGitBranch(
  cwd: string | null,
  options: UseGitBranchOptions = {},
): GitStatusInfo {
  const [state, setState] = useState<GitStatusInfo>(GIT_STATUS_ABSENT);
  const cache = useGitBranchCache();
  const latestKeyRef = useRef<string | null>(null);
  const debounceMs = options.debounceMs ?? 150;
  const immediate = options.immediate === true;
  const bridgeOverride = options.bridge;

  useEffect(() => {
    latestKeyRef.current = cwd;
    if (!cwd) {
      setState(GIT_STATUS_ABSENT);
      return;
    }
    // Synchronous cache hit — render the branch immediately on re-entry to
    // a directory we've already resolved. The effect still runs to refresh
    // in the background below.
    const cached = cacheGet(cache, cwd);
    if (cached) {
      setState(cached.value);
    }
    const bridge = bridgeOverride ?? tryGetHostBridge();
    if (!bridge || typeof bridge.readTextFile !== 'function') {
      // No bridge or the host didn't implement the readTextFile
      // capability — stay silent so the UI just doesn't show the chip.
      if (!cached) setState(GIT_STATUS_ABSENT);
      return;
    }
    const controller = new AbortController();
    const run = async () => {
      const branchInfo = await readGitBranchForCwd(cwd, {
        bridge: bridge as { readTextFile: ReadTextFileFn },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // Guard: cwd may have changed since we started; drop stale results.
      if (latestKeyRef.current !== cwd) return;

      // Step 2: best-effort `gitStatus` layering. When the host doesn't
      // implement the capability, or when we aren't in a repo, we skip
      // the extra call and cache the branch-only result.
      let status: GitStatus | null = null;
      if (branchInfo.isGitRepo && branchInfo.repoRoot) {
        status = await readGitStatusForRepo(branchInfo.repoRoot, {
          bridge: bridge as GitStatusBridge,
        });
        if (controller.signal.aborted) return;
        if (latestKeyRef.current !== cwd) return;
      }
      const result = withStatus(branchInfo, status);
      cacheSet(cache, cwd, result);
      setState(result);
    };
    if (immediate || debounceMs <= 0) {
      void run();
      return () => controller.abort();
    }
    const handle = setTimeout(() => {
      void run();
    }, debounceMs);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [cwd, debounceMs, immediate, bridgeOverride, cache]);

  return state;
}
