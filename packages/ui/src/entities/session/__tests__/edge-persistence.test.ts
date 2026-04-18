/**
 * Session store persistence invariant: the store is per-process. It MUST NOT
 * write to localStorage, sessionStorage, or any synchronous persistence
 * backend. The brief explicitly bans this because a leaked session id
 * between runs would produce ghost sessions on next launch.
 *
 * The existing selectors test covers the positive case; this file adds a
 * comprehensive sweep across every mutator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../index.js';

function storageKeys(): Set<string> {
  const keys = new Set<string>();
  if (globalThis.localStorage) {
    for (let i = 0; i < globalThis.localStorage.length; i += 1) {
      const k = globalThis.localStorage.key(i);
      if (k !== null) keys.add(`local:${k}`);
    }
  }
  if (globalThis.sessionStorage) {
    for (let i = 0; i < globalThis.sessionStorage.length; i += 1) {
      const k = globalThis.sessionStorage.key(i);
      if (k !== null) keys.add(`session:${k}`);
    }
  }
  return keys;
}

describe('session store persistence invariant', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    // Some test environments return a shim object rather than a real Storage.
    // Guard the .clear() call so the test suite runs under both jsdom and
    // minimal-shim configurations.
    if (typeof globalThis.localStorage?.clear === 'function') {
      globalThis.localStorage.clear();
    }
    if (typeof globalThis.sessionStorage?.clear === 'function') {
      globalThis.sessionStorage.clear();
    }
  });

  afterEach(() => {
    if (typeof globalThis.localStorage?.clear === 'function') {
      globalThis.localStorage.clear();
    }
    if (typeof globalThis.sessionStorage?.clear === 'function') {
      globalThis.sessionStorage.clear();
    }
  });

  it('setSession does not add any storage keys', () => {
    const before = storageKeys();
    useSessionStore.getState().setSession({ id: 'sess-42', shell: '/bin/zsh' });
    const after = storageKeys();
    expect(after).toEqual(before);
  });

  it('markExited does not add any storage keys', () => {
    const before = storageKeys();
    useSessionStore.getState().markExited(0);
    const after = storageKeys();
    expect(after).toEqual(before);
  });

  it('reset does not add any storage keys', () => {
    const before = storageKeys();
    useSessionStore.getState().reset();
    const after = storageKeys();
    expect(after).toEqual(before);
  });

  it('a sequence of 20 mutations still writes no keys', () => {
    const before = storageKeys();
    for (let i = 0; i < 20; i += 1) {
      useSessionStore.getState().setSession({ id: `sess-${i}` });
    }
    useSessionStore.getState().markExited(1);
    useSessionStore.getState().reset();
    const after = storageKeys();
    expect(after).toEqual(before);
  });
});
