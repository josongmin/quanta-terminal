import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_A11Y_ANNOUNCE_SETTINGS,
  readStoredA11ySettings,
  resolveEffectiveAnnounceMode,
  useA11yAnnounceSettings,
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
  // Rehydrate to known defaults.
  useA11yAnnounceSettings.setState({ ...DEFAULT_A11Y_ANNOUNCE_SETTINGS });
});

afterEach(() => {
  installLocalStorage();
});

describe('a11y-announce settings', () => {
  it('defaults to enabled=false, mode=polite (opt-in)', () => {
    const s = useA11yAnnounceSettings.getState();
    expect(s.enabled).toBe(false);
    expect(s.mode).toBe('polite');
  });

  it('persists enabled toggle to localStorage', () => {
    useA11yAnnounceSettings.getState().setEnabled(true);
    const stored = readStoredA11ySettings();
    expect(stored.enabled).toBe(true);
    expect(stored.mode).toBe('polite');
  });

  it('setMode("assertive") implies enabled=true', () => {
    useA11yAnnounceSettings.getState().setMode('assertive');
    const s = useA11yAnnounceSettings.getState();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('assertive');
  });

  it('setMode("off") flips enabled=false', () => {
    useA11yAnnounceSettings.getState().setMode('assertive');
    useA11yAnnounceSettings.getState().setMode('off');
    const s = useA11yAnnounceSettings.getState();
    expect(s.enabled).toBe(false);
    expect(s.mode).toBe('off');
  });

  it('cycleMode walks off → polite → assertive → off', () => {
    // start: enabled=false, mode=polite → effective off
    useA11yAnnounceSettings.getState().cycleMode();
    expect(useA11yAnnounceSettings.getState().mode).toBe('polite');
    expect(useA11yAnnounceSettings.getState().enabled).toBe(true);

    useA11yAnnounceSettings.getState().cycleMode();
    expect(useA11yAnnounceSettings.getState().mode).toBe('assertive');
    expect(useA11yAnnounceSettings.getState().enabled).toBe(true);

    useA11yAnnounceSettings.getState().cycleMode();
    expect(useA11yAnnounceSettings.getState().mode).toBe('off');
    expect(useA11yAnnounceSettings.getState().enabled).toBe(false);

    useA11yAnnounceSettings.getState().cycleMode();
    expect(useA11yAnnounceSettings.getState().mode).toBe('polite');
    expect(useA11yAnnounceSettings.getState().enabled).toBe(true);
  });

  it('resolveEffectiveAnnounceMode returns off when disabled', () => {
    expect(
      resolveEffectiveAnnounceMode({ enabled: false, mode: 'assertive' }),
    ).toBe('off');
    expect(
      resolveEffectiveAnnounceMode({ enabled: true, mode: 'assertive' }),
    ).toBe('assertive');
    // defensive coalescence when both disagree
    expect(resolveEffectiveAnnounceMode({ enabled: true, mode: 'off' })).toBe('polite');
  });

  it('tolerates corrupt stored payloads', () => {
    localStorage.setItem('quanta:a11y-announce', '{not-json');
    const stored = readStoredA11ySettings();
    expect(stored).toEqual(DEFAULT_A11Y_ANNOUNCE_SETTINGS);
  });

  it('tolerates missing fields in stored payload', () => {
    localStorage.setItem('quanta:a11y-announce', JSON.stringify({ mode: 'assertive' }));
    const stored = readStoredA11ySettings();
    expect(stored.mode).toBe('assertive');
    expect(stored.enabled).toBe(DEFAULT_A11Y_ANNOUNCE_SETTINGS.enabled);
  });
});
