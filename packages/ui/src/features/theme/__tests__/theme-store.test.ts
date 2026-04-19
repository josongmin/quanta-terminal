import { beforeEach, describe, expect, it } from 'vitest';
import {
  readStoredTheme,
  setTheme,
  useThemeStore,
  THEME_STORAGE_KEY,
} from '../theme-store.js';

/**
 * jsdom inside this project's vitest config does NOT ship a working
 * `localStorage` — accessing `localStorage.clear()` throws. We install a
 * minimal in-memory shim for the duration of these tests so `readStoredTheme`
 * can exercise the storage path.
 */
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

beforeEach(() => {
  installStorage();
  useThemeStore.getState()._rehydrate();
});

describe('theme store', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readStoredTheme()).toBe('system');
    expect(useThemeStore.getState().theme).toBe('system');
  });

  it('persists the chosen theme to localStorage', () => {
    setTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('rejects invalid values without touching storage', () => {
    setTheme('dark');
    // @ts-expect-error — deliberate runtime guard
    setTheme('hotpink');
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('rehydrates from storage set out of band', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    useThemeStore.getState()._rehydrate();
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('ignores a malformed stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'malformed-value');
    useThemeStore.getState()._rehydrate();
    expect(useThemeStore.getState().theme).toBe('system');
  });

  it('switches between all three values round-trip', () => {
    setTheme('light');
    expect(useThemeStore.getState().theme).toBe('light');
    setTheme('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    setTheme('system');
    expect(useThemeStore.getState().theme).toBe('system');
  });

  it('readStoredTheme falls back to system when storage throws', () => {
    const throwing = (): string | null => {
      throw new Error('denied');
    };
    expect(readStoredTheme(throwing)).toBe('system');
  });
});
