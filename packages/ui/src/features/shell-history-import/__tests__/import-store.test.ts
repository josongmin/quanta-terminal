/**
 * Tests for the imported-history Zustand store.
 *
 * Coverage:
 *   - ingest() persists through localStorage round-trip
 *   - clear() empties the list without flipping `ranOnce` back
 *   - markRan() is a no-op once the flag is set
 *   - corrupt persisted payloads fall back to the empty state
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IMPORT_STORAGE_KEY,
  _resetImportedHistoryForTests,
  readStoredImportedHistory,
  useImportedHistoryStore,
} from '../import-store.js';

/** Mirror of the shim pattern in features/bell/__tests__/settings.test.ts —
 *  vitest's default `happy-dom` / `jsdom` gives us a `localStorage` that
 *  isn't always a full Storage. Installing a dedicated Map-backed
 *  replacement keeps these tests deterministic. */
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

describe('imported-history store', () => {
  beforeEach(() => {
    installLocalStorage();
    _resetImportedHistoryForTests();
  });

  afterEach(() => {
    installLocalStorage();
    _resetImportedHistoryForTests();
  });

  it('starts in the empty state', () => {
    const state = useImportedHistoryStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.source).toBeNull();
    expect(state.importedAt).toBeNull();
    expect(state.ranOnce).toBe(false);
  });

  it('ingest() stores entries, sets ranOnce, and persists to localStorage', () => {
    const now = 1_700_000_000_000;
    useImportedHistoryStore.getState().ingest({
      entries: ['ls', 'pwd', 'cd'],
      source: 'zsh',
      now,
    });
    const state = useImportedHistoryStore.getState();
    expect(state.entries).toEqual(['ls', 'pwd', 'cd']);
    expect(state.source).toBe('zsh');
    expect(state.importedAt).toBe(now);
    expect(state.ranOnce).toBe(true);

    const persisted = readStoredImportedHistory();
    expect(persisted.entries).toEqual(['ls', 'pwd', 'cd']);
    expect(persisted.source).toBe('zsh');
    expect(persisted.importedAt).toBe(now);
    expect(persisted.ranOnce).toBe(true);
  });

  it('clear() empties entries but keeps ranOnce = true', () => {
    useImportedHistoryStore.getState().ingest({
      entries: ['ls'],
      source: 'bash',
    });
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);

    useImportedHistoryStore.getState().clear();
    const state = useImportedHistoryStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.source).toBeNull();
    expect(state.importedAt).toBeNull();
    expect(state.ranOnce).toBe(true);
  });

  it('markRan() flips ranOnce without mutating other fields', () => {
    expect(useImportedHistoryStore.getState().ranOnce).toBe(false);
    useImportedHistoryStore.getState().markRan();
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);
    expect(useImportedHistoryStore.getState().entries).toEqual([]);

    // Calling again is a no-op — no extra storage writes.
    useImportedHistoryStore.getState().markRan();
    expect(useImportedHistoryStore.getState().ranOnce).toBe(true);
  });

  it('readStoredImportedHistory returns defaults on corrupt payload', () => {
    localStorage.setItem(IMPORT_STORAGE_KEY, '{not valid json');
    const state = readStoredImportedHistory();
    expect(state.entries).toEqual([]);
    expect(state.source).toBeNull();
    expect(state.ranOnce).toBe(false);
  });

  it('readStoredImportedHistory returns defaults on mismatched schema version', () => {
    localStorage.setItem(
      IMPORT_STORAGE_KEY,
      JSON.stringify({
        v: 999,
        entries: ['should-not-load'],
        source: 'zsh',
        importedAt: 1,
        ranOnce: true,
      }),
    );
    const state = readStoredImportedHistory();
    expect(state.entries).toEqual([]);
    expect(state.ranOnce).toBe(false);
  });
});
