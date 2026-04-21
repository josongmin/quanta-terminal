/**
 * `.git/HEAD` parser — pure, sync, no IO.
 *
 * A HEAD file is one of three shapes:
 *   1. `ref: refs/heads/BRANCH\n` — the common "on a branch" case.
 *   2. A 40- or 64-hex-character object id (detached HEAD, or a Git with
 *      SHA-256 object format). We surface this as a short sha so the UI can
 *      still show something meaningful next to a "detached" marker.
 *   3. Anything else → `null` (treated as "unparseable; don't show the chip").
 *
 * Phase 2 note: packed-refs / worktrees aren't handled here. A worktree's
 * `.git` is a file pointing at the real gitdir; we resolve that one level
 * up in `read-branch.ts` rather than entangle this parser with IO.
 */

export interface ParsedHead {
  readonly branch: string | null;
  readonly detached: boolean;
  /** Short sha (first 7 chars) when `detached` is true; else null. */
  readonly shortSha: string | null;
}

const REF_PREFIX = 'ref: ';
const BRANCH_PREFIX = 'refs/heads/';

const SHA1_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

export function parseGitHead(content: string): ParsedHead {
  // Tolerate a BOM and trailing whitespace; git never writes a BOM but some
  // editors do, and we want to stay defensive on user-writable files.
  const trimmed = content.replace(/^\uFEFF/u, '').trim();
  if (trimmed.length === 0) {
    return { branch: null, detached: false, shortSha: null };
  }

  if (trimmed.startsWith(REF_PREFIX)) {
    const ref = trimmed.slice(REF_PREFIX.length).trim();
    if (ref.startsWith(BRANCH_PREFIX)) {
      const branch = ref.slice(BRANCH_PREFIX.length);
      return branch.length === 0
        ? { branch: null, detached: false, shortSha: null }
        : { branch, detached: false, shortSha: null };
    }
    // A symbolic ref pointing somewhere other than refs/heads — rare
    // (refs/tags/..., refs/remotes/...). Surface the tail segment so the
    // chip still has something useful; keeping `detached: false` because
    // we ARE following a named ref.
    const tail = ref.split('/').pop();
    return tail && tail.length > 0
      ? { branch: tail, detached: false, shortSha: null }
      : { branch: null, detached: false, shortSha: null };
  }

  const first = trimmed.split(/\s+/u, 1)[0] ?? '';
  if (SHA1_RE.test(first) || SHA256_RE.test(first)) {
    return {
      branch: null,
      detached: true,
      shortSha: first.slice(0, 7),
    };
  }

  return { branch: null, detached: false, shortSha: null };
}
