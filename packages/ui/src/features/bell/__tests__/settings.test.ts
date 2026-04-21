/**
 * Unit tests for bell preferences store.
 *
 * Defaults: visualBell=true, audibleBell=false. Both toggles persist to
 * localStorage and survive a reload through `readStoredBellSettings`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BELL_SETTINGS_STORAGE_KEY,
  readStoredBellSettings,
  useBellSettings,
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
  // Reset store to defaults for isolation. Reaching through setState is
  // fine because we fully own the shape here.
  useBellSettings.setState({ visualBell: true, audibleBell: false });
});

describe('bell settings', () => {
  it('defaults to visual=on audible=off', () => {
    const s = useBellSettings.getState();
    expect(s.visualBell).toBe(true);
    expect(s.audibleBell).toBe(false);
  });

  it('setVisualBell persists to localStorage', () => {
    useBellSettings.getState().setVisualBell(false);
    expect(useBellSettings.getState().visualBell).toBe(false);
    const stored = readStoredBellSettings();
    expect(stored.visualBell).toBe(false);
    expect(stored.audibleBell).toBe(false);
  });

  it('setAudibleBell persists to localStorage', () => {
    useBellSettings.getState().setAudibleBell(true);
    expect(useBellSettings.getState().audibleBell).toBe(true);
    const stored = readStoredBellSettings();
    expect(stored.audibleBell).toBe(true);
  });

  it('readStoredBellSettings tolerates corrupt JSON in storage', () => {
    localStorage.setItem(BELL_SETTINGS_STORAGE_KEY, '{ not json');
    expect(readStoredBellSettings()).toEqual({
      visualBell: true,
      audibleBell: false,
    });
  });

  it('readStoredBellSettings returns defaults via injected reader fallback', () => {
    const read = (key: string): string | null => {
      if (key === BELL_SETTINGS_STORAGE_KEY) return null;
      return null;
    };
    expect(readStoredBellSettings(read)).toEqual({
      visualBell: true,
      audibleBell: false,
    });
  });
});
