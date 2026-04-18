/**
 * features/navigation — openInEditor tests.
 *
 * Strategy: install a stub HostBridge via `setHostBridge`, then invoke the
 * feature directly. We do not touch DOM or widgets here — the renderer-side
 * integration is covered in `ui/shared/ui/ansi-output` and the widget tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import {
  openInEditor,
  resolveAbsolutePath,
  isAbsolutePath,
  validatePathForNav,
} from '../open-in-editor.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { useSessionStore } from '../../../entities/session/index.js';

function stubBridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      return { sessionId: 'x', shell: '/bin/sh', cwd: '/' };
    },
    async write() {},
    async resize() {},
    async close() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe() {
      return { unsubscribe: () => {} };
    },
    ...overrides,
  } as HostBridge;
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

afterEach(() => {
  // Each test installs its own bridge; clearing the window property keeps
  // later tests from leaking state.
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
});

describe('isAbsolutePath', () => {
  it('true for POSIX absolute', () => {
    expect(isAbsolutePath('/Users/alice/foo')).toBe(true);
  });
  it('true for Windows drive with backslash', () => {
    expect(isAbsolutePath('C:\\Users\\alice')).toBe(true);
  });
  it('true for Windows drive with forward slash', () => {
    expect(isAbsolutePath('C:/Users/alice')).toBe(true);
  });
  it('false for relative', () => {
    expect(isAbsolutePath('src/main.rs')).toBe(false);
    expect(isAbsolutePath('./a.ts')).toBe(false);
    expect(isAbsolutePath('../a.ts')).toBe(false);
  });
  it('false for empty string', () => {
    expect(isAbsolutePath('')).toBe(false);
  });
});

describe('resolveAbsolutePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolveAbsolutePath('/etc/hosts', '/cwd')).toBe('/etc/hosts');
  });

  it('joins relative path under cwd with a separator', () => {
    expect(resolveAbsolutePath('src/main.rs', '/repo')).toBe('/repo/src/main.rs');
  });

  it('does not double-slash when cwd ends with /', () => {
    expect(resolveAbsolutePath('src/main.rs', '/repo/')).toBe('/repo/src/main.rs');
  });

  it('strips a leading ./ fragment', () => {
    expect(resolveAbsolutePath('./a.ts', '/repo')).toBe('/repo/a.ts');
  });

  it('handles Windows cwd with backslash', () => {
    expect(resolveAbsolutePath('a.ts', 'C:\\repo')).toBe('C:\\repo\\a.ts');
  });

  it('returns path verbatim when cwd is empty', () => {
    expect(resolveAbsolutePath('src/a.ts', '')).toBe('src/a.ts');
  });
});

describe('validatePathForNav', () => {
  it('accepts normal paths', () => {
    expect(validatePathForNav('/Users/alice/foo.rs')).toBe(null);
  });
  it('rejects empty', () => {
    expect(validatePathForNav('')).toBeInstanceOf(Error);
  });
  it('rejects control chars', () => {
    expect(validatePathForNav('/foo\nbar')).toBeInstanceOf(Error);
    expect(validatePathForNav('/foo\tbar')).toBeInstanceOf(Error);
    expect(validatePathForNav('/foo\x00bar')).toBeInstanceOf(Error);
  });
});

describe('openInEditor', () => {
  it('returns no-bridge when no bridge is installed', async () => {
    const result = await openInEditor({ path: '/tmp/x.rs', line: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-bridge');
  });

  it('resolves a relative path against session cwd before calling the bridge', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const spy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openInEditor: spy }));
    const result = await openInEditor({ path: 'src/main.rs', line: 12, column: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedPath).toBe('/repo/src/main.rs');
    expect(spy).toHaveBeenCalledWith({ path: '/repo/src/main.rs', line: 12, column: 3 });
  });

  it('passes absolute paths through unchanged', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const spy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openInEditor: spy }));
    await openInEditor({ path: '/etc/hosts', line: 5 });
    expect(spy).toHaveBeenCalledWith({ path: '/etc/hosts', line: 5 });
  });

  it('honors an explicit cwd override', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const spy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openInEditor: spy }));
    await openInEditor({ path: 'src/a.ts', line: 1, cwd: '/other' });
    expect(spy).toHaveBeenCalledWith({ path: '/other/src/a.ts', line: 1 });
  });

  it('omits line/column from the bridge call when not provided', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const spy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openInEditor: spy }));
    await openInEditor({ path: 'src/a.ts' });
    expect(spy).toHaveBeenCalledWith({ path: '/repo/src/a.ts' });
  });

  it('surfaces bridge rejection as bridge-failed with the Error', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const err = new Error('editor not found');
    setHostBridge(stubBridge({ openInEditor: vi.fn().mockRejectedValue(err) }));
    const result = await openInEditor({ path: 'src/a.ts', line: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bridge-failed');
      expect(result.error?.message).toBe('editor not found');
    }
  });

  it('rejects a path with control characters without calling the bridge', async () => {
    useSessionStore.getState().setSession({ cwd: '/repo' });
    const spy = vi.fn();
    setHostBridge(stubBridge({ openInEditor: spy }));
    const result = await openInEditor({ path: 'src/bad\nname.ts', line: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-path');
    expect(spy).not.toHaveBeenCalled();
  });

  it('tolerates missing cwd on the session entity', async () => {
    useSessionStore.getState().setSession({ cwd: '' });
    const spy = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openInEditor: spy }));
    const result = await openInEditor({ path: 'src/a.ts', line: 1 });
    expect(result.ok).toBe(true);
    // With empty cwd we pass the path through unchanged (host will resolve).
    expect(spy).toHaveBeenCalledWith({ path: 'src/a.ts', line: 1 });
  });
});
