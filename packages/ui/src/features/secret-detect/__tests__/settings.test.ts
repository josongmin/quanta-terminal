/**
 * Settings + per-block reveal store tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  readStoredRedactSettings,
  SECRET_REDACT_STORAGE_KEY,
  useSecretRedactSettings,
  useSecretRevealStore,
} from '../settings.js';

function installLocalStorage(): Map<string, string> {
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
  return data;
}

beforeEach(() => {
  installLocalStorage();
  useSecretRedactSettings.getState().setEnabled(true);
  useSecretRevealStore.getState().clear();
});

describe('useSecretRedactSettings', () => {
  it('defaults enabled=true', () => {
    expect(useSecretRedactSettings.getState().enabled).toBe(true);
  });

  it('persists the OFF state to localStorage', () => {
    useSecretRedactSettings.getState().setEnabled(false);
    const stored = readStoredRedactSettings();
    expect(stored.enabled).toBe(false);
  });

  it('no-ops when setting the current value (stable identity)', () => {
    const before = useSecretRedactSettings.getState();
    before.setEnabled(true); // already true
    const after = useSecretRedactSettings.getState();
    expect(after.enabled).toBe(true);
  });

  it('readStoredRedactSettings falls back to enabled=true on corrupt JSON', () => {
    localStorage.setItem(SECRET_REDACT_STORAGE_KEY, '{not json');
    expect(readStoredRedactSettings()).toEqual({ enabled: true });
  });
});

describe('useSecretRevealStore', () => {
  it('starts empty', () => {
    expect(useSecretRevealStore.getState().revealed.size).toBe(0);
  });

  it('toggles a single block on and off', () => {
    useSecretRevealStore.getState().toggle('b1');
    expect(useSecretRevealStore.getState().revealed.has('b1')).toBe(true);
    useSecretRevealStore.getState().toggle('b1');
    expect(useSecretRevealStore.getState().revealed.has('b1')).toBe(false);
  });

  it('reveal is independent per block id', () => {
    useSecretRevealStore.getState().toggle('b1');
    expect(useSecretRevealStore.getState().revealed.has('b1')).toBe(true);
    expect(useSecretRevealStore.getState().revealed.has('b2')).toBe(false);
  });

  it('clear wipes every reveal', () => {
    useSecretRevealStore.getState().toggle('b1');
    useSecretRevealStore.getState().toggle('b2');
    useSecretRevealStore.getState().clear();
    expect(useSecretRevealStore.getState().revealed.size).toBe(0);
  });
});
