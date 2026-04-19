import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LONG_RUN_THRESHOLD_MS,
  MAX_LONG_RUN_THRESHOLD_MS,
  MIN_LONG_RUN_THRESHOLD_MS,
  readStoredSettings,
  useNotifySettings,
} from '../settings.js';

/**
 * jsdom's built-in Storage can be overridden by other test suites that run in
 * the same worker. Install a fresh Map-backed Storage per test so our writes
 * survive the test boundary and we read back what we wrote.
 */
function installLocalStorage(): Map<string, string> {
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
  return data;
}

beforeEach(() => {
  installLocalStorage();
  // Rehydrate the store to a known default.
  useNotifySettings.getState().setEnabled(true);
  useNotifySettings.getState().setThresholdMs(DEFAULT_LONG_RUN_THRESHOLD_MS);
});

afterEach(() => {
  // Leave a fresh empty storage for the next suite.
  installLocalStorage();
});

describe('notify-settings', () => {
  it('defaults enabled=true and threshold=10s', () => {
    expect(useNotifySettings.getState().enabled).toBe(true);
    expect(useNotifySettings.getState().longRunThresholdMs).toBe(DEFAULT_LONG_RUN_THRESHOLD_MS);
  });

  it('persists enabled across sessions (localStorage)', () => {
    useNotifySettings.getState().setEnabled(false);
    const stored = readStoredSettings();
    expect(stored.enabled).toBe(false);
  });

  it('clamps threshold below the minimum', () => {
    useNotifySettings.getState().setThresholdMs(10);
    expect(useNotifySettings.getState().longRunThresholdMs).toBe(MIN_LONG_RUN_THRESHOLD_MS);
  });

  it('clamps threshold above the maximum', () => {
    useNotifySettings.getState().setThresholdMs(999_999_999);
    expect(useNotifySettings.getState().longRunThresholdMs).toBe(MAX_LONG_RUN_THRESHOLD_MS);
  });

  it('rejects NaN and falls back to the default', () => {
    useNotifySettings.getState().setThresholdMs(Number.NaN);
    expect(useNotifySettings.getState().longRunThresholdMs).toBe(DEFAULT_LONG_RUN_THRESHOLD_MS);
  });
});
