/**
 * useGitBranch — hook behaviour.
 *
 * We drive the hook with an in-memory mock of `readTextFile`. Four scenarios:
 *   1. cwd is null → absent, no bridge calls.
 *   2. cwd is NOT inside a repo → absent after the walk resolves.
 *   3. cwd is a subdirectory of a repo → resolves to the branch of the
 *      nearest ancestor that has `.git/HEAD`.
 *   4. detached HEAD → surfaces a short-sha "branch" with `detached: true`.
 *
 * We pass `immediate: true` to skip the 150ms debounce; a separate test
 * exercises debounce coalescing.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitBranch } from '../useGitBranch.js';

interface MockBridge {
  readTextFile: ReturnType<typeof vi.fn>;
}

function makeBridge(files: Readonly<Record<string, string | null>>): MockBridge {
  return {
    readTextFile: vi.fn(async ({ path }: { path: string }) => files[path] ?? null),
  };
}

describe('useGitBranch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns absent when cwd is null and never calls the bridge', async () => {
    const bridge = makeBridge({});
    const { result } = renderHook(() =>
      useGitBranch(null, { bridge, immediate: true }),
    );
    expect(result.current.isGitRepo).toBe(false);
    expect(result.current.branch).toBeNull();
    expect(bridge.readTextFile).not.toHaveBeenCalled();
  });

  it('returns absent for a cwd with no .git ancestor', async () => {
    const bridge = makeBridge({});
    const { result } = renderHook(() =>
      useGitBranch('/Users/me/no-repo/deep', { bridge, immediate: true }),
    );
    await waitFor(() => {
      expect(bridge.readTextFile).toHaveBeenCalled();
    });
    expect(result.current.isGitRepo).toBe(false);
    expect(result.current.branch).toBeNull();
  });

  it('walks up from a subdirectory to find the nearest branch', async () => {
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': 'ref: refs/heads/trunk\n',
    });
    const { result } = renderHook(() =>
      useGitBranch('/Users/me/repo/src/features/x', { bridge, immediate: true }),
    );
    await waitFor(() => {
      expect(result.current.branch).toBe('trunk');
    });
    expect(result.current.isGitRepo).toBe(true);
    expect(result.current.repoRoot).toBe('/Users/me/repo');
    expect(result.current.detached).toBe(false);
  });

  it('surfaces a short sha on detached HEAD', async () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': `${sha}\n`,
    });
    const { result } = renderHook(() =>
      useGitBranch('/Users/me/repo', { bridge, immediate: true }),
    );
    await waitFor(() => {
      expect(result.current.detached).toBe(true);
    });
    expect(result.current.branch).toBe('abcdef0');
    expect(result.current.isGitRepo).toBe(true);
  });

  it('debounces rapid cwd changes: only the latest cwd reaches the bridge', async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({
      '/Users/me/a/.git/HEAD': 'ref: refs/heads/A\n',
      '/Users/me/b/.git/HEAD': 'ref: refs/heads/B\n',
      '/Users/me/c/.git/HEAD': 'ref: refs/heads/C\n',
    });
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string }) => useGitBranch(cwd, { bridge, debounceMs: 150 }),
      { initialProps: { cwd: '/Users/me/a' } },
    );
    rerender({ cwd: '/Users/me/b' });
    rerender({ cwd: '/Users/me/c' });
    // Advance past the debounce window.
    await act(async () => {
      vi.advanceTimersByTime(200);
      // Allow queued microtasks to flush.
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(result.current.branch).toBe('C');
    });
    // The bridge should only have been hit for the final cwd — the earlier
    // two were coalesced by the debounce.
    const calls = bridge.readTextFile.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(calls.some((p) => p.startsWith('/Users/me/c'))).toBe(true);
    expect(calls.some((p) => p === '/Users/me/a/.git/HEAD')).toBe(false);
    expect(calls.some((p) => p === '/Users/me/b/.git/HEAD')).toBe(false);
  });

  it('caches previously-resolved cwds (same cwd twice = no extra reads for the ancestors that already hit)', async () => {
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string | null }) =>
        useGitBranch(cwd, { bridge, immediate: true }),
      { initialProps: { cwd: '/Users/me/repo' as string | null } },
    );
    await waitFor(() => {
      expect(result.current.branch).toBe('main');
    });
    const firstCount = bridge.readTextFile.mock.calls.length;
    // Flip to null then back — cache should re-surface the previous value
    // synchronously on the second mount, before the bridge is re-hit.
    await act(async () => {
      rerender({ cwd: null });
    });
    await act(async () => {
      rerender({ cwd: '/Users/me/repo' });
    });
    // Cached value visible right after re-entry.
    expect(result.current.branch).toBe('main');
    // Let the background refresh settle so its setState doesn't fire
    // after the test ends (which would produce an `act()` warning).
    await waitFor(() => {
      expect(bridge.readTextFile.mock.calls.length).toBeGreaterThanOrEqual(
        firstCount + 1,
      );
    });
    expect(firstCount).toBeGreaterThan(0);
  });

  beforeEach(() => {
    // Reset any window-injected bridge so tests don't see leakage.
    if (typeof window !== 'undefined') {
      delete (window as unknown as { __QUANTA_HOST__?: unknown }).__QUANTA_HOST__;
    }
  });
});
