/**
 * Zoom store tests — clamping, step arithmetic, persistence, and DOM
 * application.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  ZOOM_STORAGE_KEY,
  useZoomStore,
} from '../zoom-store.js';

/**
 * The UI suite runs many test files in sequence; some replace localStorage
 * with custom shims. Install a fresh Map-backed Storage per test so reads
 * and writes round-trip inside this file regardless of what earlier suites
 * did to the global.
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

beforeEach(() => {
  installLocalStorage();
  useZoomStore.getState().reset();
});

afterEach(() => {
  document.documentElement.style.removeProperty('--q-zoom');
  installLocalStorage();
});

describe('zoom-store', () => {
  it('starts at the default zoom level', () => {
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_DEFAULT);
  });

  it('zoomIn increments by one step, clamped at ZOOM_MAX', () => {
    useZoomStore.getState().zoomIn();
    expect(useZoomStore.getState().zoomLevel).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 2);
    // Crank up to the ceiling.
    for (let i = 0; i < 100; i += 1) useZoomStore.getState().zoomIn();
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_MAX);
  });

  it('zoomOut decrements by one step, clamped at ZOOM_MIN', () => {
    useZoomStore.getState().zoomOut();
    expect(useZoomStore.getState().zoomLevel).toBeCloseTo(ZOOM_DEFAULT - ZOOM_STEP, 2);
    for (let i = 0; i < 100; i += 1) useZoomStore.getState().zoomOut();
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_MIN);
  });

  it('reset returns to the default', () => {
    useZoomStore.getState().zoomIn();
    useZoomStore.getState().zoomIn();
    useZoomStore.getState().reset();
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_DEFAULT);
  });

  it('setZoom clamps out-of-range inputs', () => {
    useZoomStore.getState().setZoom(5);
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_MAX);
    useZoomStore.getState().setZoom(0.1);
    expect(useZoomStore.getState().zoomLevel).toBe(ZOOM_MIN);
  });

  it('persists zoom to localStorage and applies the CSS custom property', () => {
    useZoomStore.getState().zoomIn();
    const level = useZoomStore.getState().zoomLevel;
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe(String(level));
    expect(document.documentElement.style.getPropertyValue('--q-zoom')).toBe(String(level));
  });

  it('avoids needless updates when already at the bound', () => {
    useZoomStore.getState().setZoom(ZOOM_MAX);
    const ref = useZoomStore.getState();
    useZoomStore.getState().zoomIn();
    // Still at ceiling; zoomIn past ceiling is a no-op.
    expect(useZoomStore.getState().zoomLevel).toBe(ref.zoomLevel);
  });
});
