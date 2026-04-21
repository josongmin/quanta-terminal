/**
 * Alias rewriter — custom aliases + persistence + scope. Plan 0005 P2-B.
 *
 * jsdom in this project's vitest config ships a broken `localStorage`
 * (see features/theme/__tests__/theme-store.test.ts). We install the
 * same in-memory shim so the persistence roundtrip can run.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeIntent } from '../../intent-router';
import {
  ALIAS_STORAGE_KEY,
  createAliasRewriter,
  readPersistedAliases,
  writePersistedAliases,
} from '../alias-rewriter';

function exec(text: string) {
  return makeIntent('execute', { text }, { source: 'user-keystroke' });
}

function inMemoryStore(): { get: (k: string) => string | null; set: (k: string, v: string) => void; data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    get: (k) => (k in data ? data[k]! : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function installStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k: string) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i: number) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k: string) {
      data.delete(k);
    },
    setItem(k: string, v: string) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

describe('alias-rewriter', () => {
  beforeEach(() => {
    installStorage();
  });

  it('rewrites `gs` → `git status` (default alias)', () => {
    const rw = createAliasRewriter({ loadPersisted: () => ({}) });
    const out = rw(exec('gs'));
    expect(out).not.toBeNull();
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('git status');
    }
  });

  it('rewrites only first word (alias in middle → untouched)', () => {
    const rw = createAliasRewriter({ loadPersisted: () => ({}) });
    const out = rw(exec('echo gs'));
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('echo gs');
    }
  });

  it('preserves arguments after the alias', () => {
    const rw = createAliasRewriter({ loadPersisted: () => ({}) });
    const out = rw(exec('gco feature-branch'));
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('git checkout feature-branch');
    }
  });

  it('custom alias from `aliases` option beats default', () => {
    const rw = createAliasRewriter({
      aliases: { gs: 'echo REPLACED' },
      loadPersisted: () => ({}),
    });
    const out = rw(exec('gs'));
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('echo REPLACED');
    }
  });

  it('persisted alias (from storage) is picked up', () => {
    const rw = createAliasRewriter({
      loadPersisted: () => ({ foo: 'bar baz' }),
    });
    const out = rw(exec('foo arg1'));
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('bar baz arg1');
    }
  });

  it('execute-raw is NOT rewritten', () => {
    const rw = createAliasRewriter({ loadPersisted: () => ({}) });
    const i = makeIntent('execute-raw', { text: 'gs' }, { source: 'replay' });
    const out = rw(i);
    expect(out).not.toBeNull();
    if (out && out.kind === 'execute-raw') {
      expect(out.payload.text).toBe('gs');
    }
  });

  it('readPersistedAliases handles malformed JSON gracefully', () => {
    const store = inMemoryStore();
    store.set(ALIAS_STORAGE_KEY, 'not-json {');
    const out = readPersistedAliases((k) => store.get(k));
    expect(out).toEqual({});
  });

  it('writePersistedAliases + readPersistedAliases roundtrip via localStorage', () => {
    writePersistedAliases({ my: 'command' });
    const out = readPersistedAliases();
    expect(out).toEqual({ my: 'command' });
  });

  it('replaceDefaults: true skips the default alias map', () => {
    const rw = createAliasRewriter({
      aliases: { z: 'zoxide' },
      replaceDefaults: true,
      loadPersisted: () => ({}),
    });
    // Default `gs` should NOT map.
    const out = rw(exec('gs'));
    if (out && out.kind === 'execute') {
      expect(out.payload.text).toBe('gs');
    }
  });
});
