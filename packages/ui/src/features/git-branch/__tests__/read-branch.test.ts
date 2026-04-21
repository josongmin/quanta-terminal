import { describe, expect, it, vi } from 'vitest';
import { ancestors, readGitBranchForCwd } from '../read-branch.js';

describe('ancestors', () => {
  it('walks up to the root', () => {
    expect(ancestors('/Users/me/code/app/src')).toEqual([
      '/Users/me/code/app/src',
      '/Users/me/code/app',
      '/Users/me/code',
      '/Users/me',
      '/Users',
      '/',
    ]);
  });

  it('normalises a trailing slash', () => {
    expect(ancestors('/Users/me/')[0]).toBe('/Users/me');
  });

  it('rejects a relative path', () => {
    expect(ancestors('relative/thing')).toEqual([]);
  });

  it('handles the root specifically', () => {
    expect(ancestors('/')).toEqual(['/']);
  });
});

function makeBridge(files: Readonly<Record<string, string | null>>) {
  const seen: string[] = [];
  return {
    seen,
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      seen.push(path);
      return files[path] ?? null;
    }),
  };
}

describe('readGitBranchForCwd', () => {
  it('returns absent when cwd is empty / null', async () => {
    const bridge = makeBridge({});
    const result = await readGitBranchForCwd(null, { bridge });
    expect(result.isGitRepo).toBe(false);
    expect(result.branch).toBeNull();
    expect(bridge.readTextFile).not.toHaveBeenCalled();
  });

  it('returns absent when no ancestor has a .git/HEAD', async () => {
    const bridge = makeBridge({});
    const result = await readGitBranchForCwd('/Users/me/no-repo/here', { bridge });
    expect(result.isGitRepo).toBe(false);
    expect(result.branch).toBeNull();
    // Walked up to /, exactly one readTextFile per ancestor.
    expect(bridge.readTextFile.mock.calls.length).toBe(
      ancestors('/Users/me/no-repo/here').length,
    );
  });

  it('finds the branch in an immediate .git/HEAD', async () => {
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    const result = await readGitBranchForCwd('/Users/me/repo', { bridge });
    expect(result.isGitRepo).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.repoRoot).toBe('/Users/me/repo');
  });

  it('walks up from a subdirectory', async () => {
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': 'ref: refs/heads/topic/fix\n',
    });
    const result = await readGitBranchForCwd('/Users/me/repo/src/deep/nested', {
      bridge,
    });
    expect(result.branch).toBe('topic/fix');
    expect(result.repoRoot).toBe('/Users/me/repo');
  });

  it('reports detached HEAD as a short sha', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': `${sha}\n`,
    });
    const result = await readGitBranchForCwd('/Users/me/repo', { bridge });
    expect(result.isGitRepo).toBe(true);
    expect(result.detached).toBe(true);
    expect(result.branch).toBe('0123456');
  });

  it('stops walking once HEAD is found, even if a parent also has a .git', async () => {
    const bridge = makeBridge({
      '/Users/me/outer/.git/HEAD': 'ref: refs/heads/outer\n',
      '/Users/me/outer/inner/.git/HEAD': 'ref: refs/heads/inner\n',
    });
    const result = await readGitBranchForCwd('/Users/me/outer/inner/src', { bridge });
    expect(result.branch).toBe('inner');
    expect(result.repoRoot).toBe('/Users/me/outer/inner');
    // Should NOT have read the outer HEAD after finding the inner one.
    expect(bridge.seen).not.toContain('/Users/me/outer/.git/HEAD');
  });

  it('stops early when the abort signal is fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const bridge = makeBridge({
      '/Users/me/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    const result = await readGitBranchForCwd('/Users/me/repo', {
      bridge,
      signal: controller.signal,
    });
    expect(result.isGitRepo).toBe(false);
    expect(bridge.readTextFile).not.toHaveBeenCalled();
  });

  it('gracefully handles bridge rejections', async () => {
    const bridge = {
      readTextFile: vi.fn(async () => {
        throw new Error('bridge broken');
      }),
    };
    const result = await readGitBranchForCwd('/Users/me/repo', { bridge });
    expect(result.isGitRepo).toBe(false);
    expect(result.branch).toBeNull();
  });

  it('aborts mid-walk: signal fired during second readTextFile returns null, no further calls', async () => {
    // Walk path: /Users/me/deep/sub -> /Users/me/deep -> /Users/me -> ...
    // The .git/HEAD lives at /Users/me/.git/HEAD so the walker must check
    // at least two ancestors before finding it. We abort on the second call.
    const controller = new AbortController();
    let callCount = 0;
    const bridge = {
      seen: [] as string[],
      readTextFile: vi.fn(async ({ path }: { path: string }) => {
        callCount += 1;
        bridge.seen.push(path);
        if (callCount === 2) {
          // Abort the signal while this second await is "in-flight".
          controller.abort();
        }
        // Return null (file not found) for all paths.
        return null;
      }),
    };
    const result = await readGitBranchForCwd('/Users/me/deep/sub', {
      bridge,
      signal: controller.signal,
    });
    expect(result.isGitRepo).toBe(false);
    expect(result.branch).toBeNull();
    // Exactly two bridge calls were made; the third was never issued because
    // the post-await abort check fired.
    expect(bridge.readTextFile).toHaveBeenCalledTimes(2);
  });
});
