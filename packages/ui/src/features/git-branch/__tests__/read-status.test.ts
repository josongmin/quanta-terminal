/**
 * `readGitStatusForRepo` — bridge wrapper with caching + coalescing.
 *
 * The cache is module-scope, so each test resets it via
 * `__resetGitStatusCacheForTests` in `beforeEach`. We drive a virtual
 * clock so TTL behaviour is deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readGitStatusForRepo,
  getCachedGitStatus,
  invalidateGitStatusCache,
  GIT_STATUS_CACHE_TTL_MS,
  __resetGitStatusCacheForTests,
} from '../read-status.js';
import type { GitStatus } from '@quanta/host-common';

function makeBridge(
  impl: (repoRoot: string) => Promise<GitStatus | null> | GitStatus | null,
) {
  return {
    gitStatus: vi.fn(async ({ repoRoot }: { repoRoot: string }) => impl(repoRoot)),
  };
}

const OK: GitStatus = {
  branch: 'main',
  dirty: false,
  ahead: 0,
  behind: 0,
  detached: false,
};

describe('readGitStatusForRepo', () => {
  beforeEach(() => {
    __resetGitStatusCacheForTests();
  });

  it('returns null when the bridge has no gitStatus capability', async () => {
    const bridge = {}; // no method at all
    const out = await readGitStatusForRepo('/repo', { bridge });
    expect(out).toBeNull();
  });

  it('delegates to the bridge and returns its reply', async () => {
    const bridge = makeBridge(() => OK);
    const out = await readGitStatusForRepo('/repo', { bridge });
    expect(out).toEqual(OK);
    expect(bridge.gitStatus).toHaveBeenCalledOnce();
  });

  it('serves a cached reply within the TTL without re-hitting the bridge', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const bridge = makeBridge(() => OK);
    await readGitStatusForRepo('/repo', { bridge, now });
    clock += GIT_STATUS_CACHE_TTL_MS - 1;
    const again = await readGitStatusForRepo('/repo', { bridge, now });
    expect(again).toEqual(OK);
    expect(bridge.gitStatus).toHaveBeenCalledOnce();
  });

  it('re-fetches once the TTL has expired', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const bridge = makeBridge(() => OK);
    await readGitStatusForRepo('/repo', { bridge, now });
    clock += GIT_STATUS_CACHE_TTL_MS + 1;
    await readGitStatusForRepo('/repo', { bridge, now });
    expect(bridge.gitStatus).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-flight callers for the same repoRoot', async () => {
    let resolve!: (v: GitStatus | null) => void;
    const bridge = {
      gitStatus: vi.fn(
        () => new Promise<GitStatus | null>((r) => (resolve = r)),
      ),
    };
    const p1 = readGitStatusForRepo('/repo', { bridge });
    const p2 = readGitStatusForRepo('/repo', { bridge });
    // Only one underlying invocation.
    expect(bridge.gitStatus).toHaveBeenCalledOnce();
    resolve(OK);
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toEqual(OK);
    expect(v2).toEqual(OK);
  });

  it('passes through a null bridge reply (not a repo) and caches it', async () => {
    const bridge = makeBridge(() => null);
    const out1 = await readGitStatusForRepo('/not-a-repo', { bridge });
    const out2 = await readGitStatusForRepo('/not-a-repo', { bridge });
    expect(out1).toBeNull();
    expect(out2).toBeNull();
    expect(bridge.gitStatus).toHaveBeenCalledOnce();
  });

  it('swallows a rejection from the bridge as null', async () => {
    const bridge = {
      gitStatus: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const out = await readGitStatusForRepo('/repo', { bridge });
    expect(out).toBeNull();
  });

  it('forceRefresh bypasses the cache', async () => {
    const bridge = makeBridge(() => OK);
    await readGitStatusForRepo('/repo', { bridge });
    await readGitStatusForRepo('/repo', { bridge, forceRefresh: true });
    expect(bridge.gitStatus).toHaveBeenCalledTimes(2);
  });

  it('invalidateGitStatusCache clears a specific entry', async () => {
    const bridge = makeBridge(() => OK);
    await readGitStatusForRepo('/repo', { bridge });
    invalidateGitStatusCache('/repo');
    await readGitStatusForRepo('/repo', { bridge });
    expect(bridge.gitStatus).toHaveBeenCalledTimes(2);
  });

  it('getCachedGitStatus returns undefined when outside the TTL', () => {
    let clock = 1_000_000;
    const bridge = makeBridge(() => OK);
    // Prime the cache.
    void readGitStatusForRepo('/repo', { bridge, now: () => clock });
    // Still within TTL: either cached OR in-flight (both return non-undefined
    // later). We specifically test the expired case.
    clock += GIT_STATUS_CACHE_TTL_MS + 5;
    expect(getCachedGitStatus('/repo', () => clock)).toBeUndefined();
  });
});
