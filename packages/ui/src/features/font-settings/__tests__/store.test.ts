/**
 * Font-settings store tests — defaults, persistence round-trip, size clamp,
 * ligature toggle, and document-side CSS variable application.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useFontSettings,
  FONT_SETTINGS_STORAGE_KEY,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_DEFAULT,
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_LIGATURES,
  FONT_FAMILY_OPTIONS,
  clampFontSize,
  resolveFamilyCss,
  resolveFeatureSettings,
  readStoredFontSettings,
} from '../store.js';

/**
 * Fresh Map-backed Storage per test so reads and writes round-trip inside
 * this file regardless of what earlier suites did to the global. Same shim
 * used by the zoom-store tests.
 */
function installLocalStorage(): void {
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

function clearRootFontVars(): void {
  const root = document.documentElement;
  root.style.removeProperty('--quanta-font-family');
  root.style.removeProperty('--quanta-font-size');
  root.style.removeProperty('--quanta-font-features');
  root.style.removeProperty('--q-font-mono');
  root.style.removeProperty('--q-font-size-term');
  root.style.removeProperty('--q-font-features');
}

beforeEach(() => {
  installLocalStorage();
  clearRootFontVars();
  // Rehydrate reads fresh state from (the now-empty) storage.
  useFontSettings.getState()._rehydrate();
});

afterEach(() => {
  clearRootFontVars();
  installLocalStorage();
});

describe('font-settings store', () => {
  it('starts with the documented defaults', () => {
    const s = useFontSettings.getState();
    expect(s.family).toBe(DEFAULT_FONT_FAMILY_ID);
    expect(s.size).toBe(FONT_SIZE_DEFAULT);
    expect(s.ligatures).toBe(DEFAULT_LIGATURES);
  });

  it('setFamily persists a known family and ignores unknown ids', () => {
    useFontSettings.getState().setFamily('jetbrains');
    expect(useFontSettings.getState().family).toBe('jetbrains');
    // Unknown ids fall back to the default rather than polluting the store.
    useFontSettings.getState().setFamily('helvetica-lol');
    expect(useFontSettings.getState().family).toBe(DEFAULT_FONT_FAMILY_ID);
  });

  it('setSize clamps out-of-range inputs', () => {
    useFontSettings.getState().setSize(999);
    expect(useFontSettings.getState().size).toBe(FONT_SIZE_MAX);
    useFontSettings.getState().setSize(-5);
    expect(useFontSettings.getState().size).toBe(FONT_SIZE_MIN);
    // Fractional px rounds to the nearest integer.
    useFontSettings.getState().setSize(14.7);
    expect(useFontSettings.getState().size).toBe(15);
  });

  it('clampFontSize rejects NaN / Infinity by falling back to the default', () => {
    // Non-finite inputs collapse to the default so a malformed slider value
    // (NaN after Number.parseFloat of an empty string) cannot crash the
    // render path; this matches the zoom-store contract.
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
  });

  it('toggleLigatures flips the boolean and writes a feature-string override', () => {
    expect(useFontSettings.getState().ligatures).toBe(true);
    useFontSettings.getState().toggleLigatures();
    expect(useFontSettings.getState().ligatures).toBe(false);
    useFontSettings.getState().toggleLigatures();
    expect(useFontSettings.getState().ligatures).toBe(true);
  });

  it('persists every setting to localStorage and round-trips on rehydrate', () => {
    useFontSettings.getState().setFamily('firacode');
    useFontSettings.getState().setSize(18);
    useFontSettings.getState().toggleLigatures(); // false
    const raw = localStorage.getItem(FONT_SETTINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ family: 'firacode', size: 18, ligatures: false });
    // Rehydrate returns the same values after a fresh read.
    useFontSettings.getState()._rehydrate();
    expect(useFontSettings.getState().family).toBe('firacode');
    expect(useFontSettings.getState().size).toBe(18);
    expect(useFontSettings.getState().ligatures).toBe(false);
  });

  it('applies CSS custom properties to the document root', () => {
    useFontSettings.getState().setFamily('jetbrains');
    useFontSettings.getState().setSize(16);
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--quanta-font-family')).toBe(
      resolveFamilyCss('jetbrains'),
    );
    expect(root.getPropertyValue('--quanta-font-size')).toBe('16px');
    // Mirrored tokens drive the 50+ existing --q-font-mono callsites.
    expect(root.getPropertyValue('--q-font-mono')).toBe(resolveFamilyCss('jetbrains'));
    expect(root.getPropertyValue('--q-font-size-term')).toBe('16px');
    expect(root.getPropertyValue('--q-font-features')).toBe(resolveFeatureSettings(true));
    // Flip ligatures off and confirm the feature var now says so.
    useFontSettings.getState().toggleLigatures();
    expect(root.getPropertyValue('--q-font-features')).toBe(resolveFeatureSettings(false));
  });

  it('readStoredFontSettings tolerates malformed JSON and unknown family ids', () => {
    installLocalStorage();
    localStorage.setItem(FONT_SETTINGS_STORAGE_KEY, '{not valid json');
    const a = readStoredFontSettings();
    expect(a.family).toBe(DEFAULT_FONT_FAMILY_ID);
    expect(a.size).toBe(FONT_SIZE_DEFAULT);

    localStorage.setItem(
      FONT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ family: 'wingdings', size: 'huge', ligatures: 'yes' }),
    );
    const b = readStoredFontSettings();
    expect(b.family).toBe(DEFAULT_FONT_FAMILY_ID);
    expect(b.size).toBe(FONT_SIZE_DEFAULT);
    expect(b.ligatures).toBe(DEFAULT_LIGATURES);
  });

  it('exposes a curated, non-empty FONT_FAMILY_OPTIONS list with System first', () => {
    expect(FONT_FAMILY_OPTIONS.length).toBeGreaterThan(1);
    expect(FONT_FAMILY_OPTIONS[0]!.id).toBe('system');
    for (const opt of FONT_FAMILY_OPTIONS) {
      expect(opt.fallback).toMatch(/monospace/);
    }
  });
});
