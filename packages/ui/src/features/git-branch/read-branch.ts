/**
 * Walk up from a cwd looking for `.git/HEAD` and parse it.
 *
 * The bridge's `readTextFile` is the only IO primitive — we never shell out
 * and never touch `fs` directly from the UI process. That keeps the feature
 * portable across Tauri, VS Code, and the browser mock (which simply always
 * resolves `null`, yielding "not a repo" everywhere).
 *
 * Walk strategy
 * -------------
 * For each ancestor `dir` of `cwd`, try `dir/.git/HEAD`. If the bridge
 * returns `null` (file missing), step up one level. If the bridge returns
 * content we parse it and return. A hard cap on walk depth (32 levels) keeps
 * a pathological path from hammering the IPC channel.
 *
 * Phase 2 candidates — intentionally out of scope for this pass:
 *   - worktree resolution: a `.git` FILE instead of a directory points at
 *     the real gitdir; we'd read that, follow the `gitdir: ...` line, then
 *     read HEAD from there. The TODO is marked inline.
 *   - packed-refs fallback for refs that don't have a loose file.
 *   - dirty / ahead-behind status (phase-2 per the brief).
 */

import type { HostBridge } from '@quanta/host-common';
import { parseGitHead } from './parse-head.js';

export interface GitBranchInfo {
  readonly branch: string | null;
  readonly isGitRepo: boolean;
  /** Absolute path to the repo root (the dir that contains `.git`). */
  readonly repoRoot: string | null;
  /** True when HEAD points at a detached commit; `branch` carries the short sha. */
  readonly detached: boolean;
}

export const GIT_BRANCH_ABSENT: GitBranchInfo = {
  branch: null,
  isGitRepo: false,
  repoRoot: null,
  detached: false,
};

const MAX_WALK_DEPTH = 32;

/**
 * Split a POSIX-style absolute path into parent directories, starting with
 * the path itself and walking up to `/`. Non-absolute paths return an empty
 * list — we refuse to guess at a cwd-relative root.
 */
export function ancestors(cwd: string): readonly string[] {
  if (!cwd.startsWith('/')) return [];
  // Normalize: strip trailing slash unless it IS the root.
  let normalized = cwd;
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/u, '');
  }
  const out: string[] = [];
  let current: string | null = normalized;
  while (current !== null) {
    out.push(current);
    if (current === '/') break;
    if (out.length >= MAX_WALK_DEPTH) break;
    const idx = current.lastIndexOf('/');
    if (idx <= 0) {
      current = '/';
    } else {
      current = current.slice(0, idx);
    }
  }
  return out;
}

export interface ReadBranchOptions {
  readonly bridge: Pick<HostBridge, 'readTextFile'>;
  readonly signal?: AbortSignal;
}

export async function readGitBranchForCwd(
  cwd: string | null | undefined,
  options: ReadBranchOptions,
): Promise<GitBranchInfo> {
  if (!cwd) return GIT_BRANCH_ABSENT;
  const dirs = ancestors(cwd);
  for (const dir of dirs) {
    if (options.signal?.aborted) return GIT_BRANCH_ABSENT;
    const headPath = joinPath(dir, '.git/HEAD');
    let content: string | null;
    try {
      // 4 KiB is ample for a HEAD file (~60 bytes in practice). Cap here
      // keeps a malicious or corrupt HEAD from pulling 64 KiB.
      content = await options.bridge.readTextFile({ path: headPath, maxBytes: 4096 });
    } catch {
      // Bridge-level rejection — treat as unreadable and bail. The hook
      // will retry on the next cwd change.
      return GIT_BRANCH_ABSENT;
    }
    // Check abort after every await — the signal may have fired while the
    // bridge call was in-flight (e.g. the cwd changed between two sequential
    // readTextFile calls during the walk-up).
    if (options.signal?.aborted) return GIT_BRANCH_ABSENT;
    if (content === null) continue;
    // TODO(phase-2): when `.git` is a FILE we'll land here with content
    // starting "gitdir: /path/to/real/gitdir\n"; parse and re-issue a
    // readTextFile against that dir's HEAD.
    const parsed = parseGitHead(content);
    if (parsed.branch !== null) {
      return {
        branch: parsed.branch,
        isGitRepo: true,
        repoRoot: dir,
        detached: false,
      };
    }
    if (parsed.detached && parsed.shortSha !== null) {
      return {
        branch: parsed.shortSha,
        isGitRepo: true,
        repoRoot: dir,
        detached: true,
      };
    }
    // HEAD present but unparseable — still a git repo, just no branch to
    // show. Surface isGitRepo: true with a null branch so the hook can
    // stay silent (the StatusBar omits the chip when branch is null).
    return { branch: null, isGitRepo: true, repoRoot: dir, detached: false };
  }
  return GIT_BRANCH_ABSENT;
}

function joinPath(dir: string, tail: string): string {
  if (dir.endsWith('/')) return dir + tail;
  return dir + '/' + tail;
}
