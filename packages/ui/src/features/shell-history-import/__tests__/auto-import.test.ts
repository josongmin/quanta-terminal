/**
 * Integration tests for the shell-history auto-import orchestrator.
 *
 * The flow under test:
 *   1. runAutoImport reads $HOME via `bridge.getHomeDir`
 *   2. tries zsh → bash → fish in order
 *   3. ingests the first file that parses to ≥ 1 command
 *   4. marks ranOnce (regardless of outcome)
 *   5. re-invocation is a no-op
 *
 * The bridge is a minimal in-memory mock; we assert both the store
 * mutations and the exact readTextFile call order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';

import { runAutoImport, runImportForce } from '../auto-import.js';
import {
  _resetImportedHistoryForTests,
  useImportedHistoryStore,
} from '../import-store.js';

/** See import-store.test.ts — shim pattern borrowed from features/bell. */
function installLocalStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k) {
      data.delete(k);
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

interface MockBridge
  extends Pick<HostBridge, 'getHomeDir' | 'readTextFile'> {
  readonly calls: { readonly path: string }[];
}

function makeBridge(files: Record<string, string | null>, homeDir: string | null = '/home/test'): MockBridge {
  const calls: { path: string }[] = [];
  return {
    calls,
    getHomeDir: vi.fn(async () => homeDir),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      calls.push({ path });
      // `undefined` entries in the dictionary map to `null` to match the
      // bridge contract (missing file → null).
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] ?? null : null;
    }),
  };
}

describe('runAutoImport', () => {
  beforeEach(() => {
    installLocalStorage();
    _resetImportedHistoryForTests();
  });

  afterEach(() => {
    installLocalStorage();
    _resetImportedHistoryForTests();
  });

  it('reads zsh_history first and short-circuits the others', async () => {
    const bridge = makeBridge({
      '/home/test/.zsh_history': [': 1700000000:0;ls', ': 1700000001:0;pwd'].join('\n'),
      '/home/test/.bash_history': 'should-not-read',
    });

    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(true);
    expect(result.source).toBe('zsh');
    expect(result.count).toBe(2);

    const state = useImportedHistoryStore.getState();
    expect(state.ranOnce).toBe(true);
    expect(state.source).toBe('zsh');
    expect(state.entries).toEqual(['ls', 'pwd']);

    // Only zsh was read; bash and fish paths never hit.
    const paths = bridge.calls.map((c) => c.path);
    expect(paths).toEqual(['/home/test/.zsh_history']);
  });

  it('falls through to bash when zsh is missing', async () => {
    const bridge = makeBridge({
      '/home/test/.bash_history': ['ls', '#1700000000', 'cd'].join('\n'),
    });

    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(true);
    expect(result.source).toBe('bash');
    expect(result.count).toBe(2);

    expect(useImportedHistoryStore.getState().entries).toEqual(['ls', 'cd']);

    const paths = bridge.calls.map((c) => c.path);
    expect(paths).toEqual([
      '/home/test/.zsh_history',
      '/home/test/.bash_history',
    ]);
  });

  it('falls through to fish when zsh and bash are missing', async () => {
    const bridge = makeBridge({
      '/home/test/.config/fish/fish_history': [
        '- cmd: ls',
        '  when: 1',
        '- cmd: cd /tmp',
      ].join('\n'),
    });

    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(true);
    expect(result.source).toBe('fish');
    expect(result.count).toBe(2);
  });

  it('marks ranOnce=true even when no file exists, and reports the reason', async () => {
    const bridge = makeBridge({});
    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(false);
    expect(result.skipReason).toBe('no-files-readable');
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);
  });

  it('does NOT re-run once ranOnce is set', async () => {
    useImportedHistoryStore.getState().markRan();
    const bridge = makeBridge({
      '/home/test/.zsh_history': 'ls\npwd',
    });
    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(false);
    // No read happened — the short-circuit fired before we opened any file.
    expect(bridge.calls.length).toBe(0);
  });

  it('runImportForce bypasses the ranOnce short-circuit', async () => {
    useImportedHistoryStore.getState().markRan();
    const bridge = makeBridge({
      '/home/test/.zsh_history': 'ls\npwd',
    });
    const result = await runImportForce({ bridge });
    expect(result.imported).toBe(true);
    expect(result.count).toBe(2);
  });

  it('skips when getHomeDir resolves null', async () => {
    const bridge = makeBridge({}, null);
    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(false);
    expect(result.skipReason).toBe('no-home-dir');
    expect(bridge.readTextFile).not.toHaveBeenCalled();
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);
  });

  it('reports no-bridge-support when getHomeDir is absent entirely', async () => {
    const bridge: Pick<HostBridge, 'readTextFile'> = {
      readTextFile: vi.fn(async () => null),
    };
    const result = await runAutoImport({
      bridge: bridge as Pick<HostBridge, 'getHomeDir' | 'readTextFile'>,
    });
    expect(result.imported).toBe(false);
    expect(result.skipReason).toBe('no-bridge-support');
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);
  });

  it('treats an empty history file as "no import" and keeps looking', async () => {
    const bridge = makeBridge({
      '/home/test/.zsh_history': '',
      '/home/test/.bash_history': 'ls',
    });
    const result = await runAutoImport({ bridge });
    expect(result.imported).toBe(true);
    expect(result.source).toBe('bash');
    expect(result.count).toBe(1);
  });
});
