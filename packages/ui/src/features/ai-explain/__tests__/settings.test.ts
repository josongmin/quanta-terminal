/**
 * AI explain-error settings store — persistence & toggle behavior.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AI_EXPLAIN_STORAGE_KEY,
  readStoredAiExplainSettings,
  useAiExplainSettings,
  __resetAiExplainSettingsForTests,
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
  __resetAiExplainSettingsForTests();
});

describe('useAiExplainSettings', () => {
  it('defaults enabled=true and autoExplainThresholdExitCode=null', () => {
    const s = useAiExplainSettings.getState();
    expect(s.enabled).toBe(true);
    expect(s.autoExplainThresholdExitCode).toBeNull();
  });

  it('persists the disabled state to localStorage', () => {
    useAiExplainSettings.getState().setEnabled(false);
    const stored = readStoredAiExplainSettings();
    expect(stored.enabled).toBe(false);
    expect(stored.autoExplainThresholdExitCode).toBeNull();
  });

  it('no-ops when setting the current value', () => {
    useAiExplainSettings.getState().setEnabled(true);
    expect(useAiExplainSettings.getState().enabled).toBe(true);
  });

  it('persists autoExplainThresholdExitCode updates', () => {
    useAiExplainSettings.getState().setAutoExplainThresholdExitCode(1);
    const stored = readStoredAiExplainSettings();
    expect(stored.autoExplainThresholdExitCode).toBe(1);
  });

  it('readStoredAiExplainSettings falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(AI_EXPLAIN_STORAGE_KEY, '{not json');
    expect(readStoredAiExplainSettings()).toEqual({
      enabled: true,
      autoExplainThresholdExitCode: null,
    });
  });

  it('readStoredAiExplainSettings respects a well-formed stored value', () => {
    localStorage.setItem(
      AI_EXPLAIN_STORAGE_KEY,
      JSON.stringify({ enabled: false, autoExplainThresholdExitCode: 127 }),
    );
    expect(readStoredAiExplainSettings()).toEqual({
      enabled: false,
      autoExplainThresholdExitCode: 127,
    });
  });
});
