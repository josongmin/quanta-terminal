/**
 * feature-flags tests — Plan 0005 Epic δ.
 *
 * Covers the eight acceptance cases enumerated in the epic:
 *   1. Default — `blockUx` is `false` with empty storage.
 *   2. Read   — `getFeatureFlag` returns the live value.
 *   3. Write  — `setFeatureFlag('blockUx', true)` flips the value.
 *   4. Persistence — a write lands in `localStorage` under the canonical key.
 *   5. Hydrate — the store reads persisted values on init.
 *   6. Reset  — `resetFeatureFlags` restores defaults.
 *   7. Invalid key — `setFeatureFlag` with a key outside `FeatureFlags`
 *                    is a no-op (safety against typo-created ghost flags).
 *   8. Malformed storage — bogus JSON in localStorage falls back to defaults.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FLAGS,
  FEATURE_FLAGS_STORAGE_KEY,
  getFeatureFlag,
  readStoredFlags,
  resetFeatureFlags,
  setFeatureFlag,
  useFeatureFlagsStore,
} from '../feature-flags.js';

/**
 * jsdom in this project doesn't ship a working `localStorage` (calling
 * `clear()` throws). Copy the theme-store test's in-memory shim so our
 * persistence assertions exercise real read/write paths.
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
  useFeatureFlagsStore.getState()._rehydrate();
});

afterEach(() => {
  localStorage.removeItem(FEATURE_FLAGS_STORAGE_KEY);
  useFeatureFlagsStore.getState()._rehydrate();
});

describe('feature-flags', () => {
  it('defaults blockUx to false when storage is empty', () => {
    expect(DEFAULT_FLAGS.blockUx).toBe(false);
    expect(getFeatureFlag('blockUx')).toBe(false);
  });

  it('reads the current value via getFeatureFlag', () => {
    setFeatureFlag('blockUx', true);
    expect(getFeatureFlag('blockUx')).toBe(true);
    setFeatureFlag('blockUx', false);
    expect(getFeatureFlag('blockUx')).toBe(false);
  });

  it('writes the value via setFeatureFlag and observes it in the store', () => {
    setFeatureFlag('blockUx', true);
    expect(useFeatureFlagsStore.getState().flags.blockUx).toBe(true);
  });

  it('persists writes to localStorage under quanta:feature-flags', () => {
    setFeatureFlag('blockUx', true);
    const raw = localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.blockUx).toBe(true);
  });

  it('hydrates the store from persisted values on rehydrate', () => {
    localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ blockUx: true }),
    );
    useFeatureFlagsStore.getState()._rehydrate();
    expect(getFeatureFlag('blockUx')).toBe(true);
  });

  it('resetFeatureFlags restores defaults and clears a previously-set flag', () => {
    setFeatureFlag('blockUx', true);
    expect(getFeatureFlag('blockUx')).toBe(true);
    resetFeatureFlags();
    expect(getFeatureFlag('blockUx')).toBe(false);
    const raw = localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.blockUx).toBe(false);
  });

  it('ignores invalid keys — setFeatureFlag with an unknown key is a no-op', () => {
    // Cast through `any` — at the type level `keyof FeatureFlags` accepts
    // any string via the index signature, so we validate at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFeatureFlag('notARealFlag' as any, true);
    const raw = localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY);
    // No persistence happened — the write was rejected.
    expect(raw).toBeNull();
    expect(useFeatureFlagsStore.getState().flags.notARealFlag).toBeUndefined();
  });

  it('falls back to defaults when stored JSON is malformed', () => {
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, '{not valid json');
    const flags = readStoredFlags();
    expect(flags.blockUx).toBe(false);
  });
});
