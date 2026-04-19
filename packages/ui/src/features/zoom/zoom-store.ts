/**
 * Zoom store — scale factor for the terminal surface.
 *
 * Range: 0.5 .. 2.0 in 0.1 increments. The factor is written to the
 * `--q-zoom` CSS custom property at the document root so every component
 * that opts into the token system (block output, composer, terminal) scales
 * in lockstep. Persisted to localStorage so the user's preferred size
 * survives a reload.
 *
 * Rationale for clamping inside the store: the keymap handler calls
 * `zoomIn` / `zoomOut` without bounds-checking, and the Settings panel
 * exposes a slider. Centralizing the clamp keeps both callers honest and
 * avoids a render with a size the token stylesheet didn't anticipate.
 */

import { create } from 'zustand';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1.0;
export const ZOOM_STORAGE_KEY = 'quanta:zoom';

export interface ZoomStore {
  readonly zoomLevel: number;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly reset: () => void;
  readonly setZoom: (next: number) => void;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  // Round to the nearest step to avoid drift from repeated additions (0.1
  // doesn't round-trip perfectly in binary floats). One decimal place is
  // exactly `ZOOM_STEP`'s precision.
  const rounded = Math.round(value * 10) / 10;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rounded));
}

export function readStoredZoom(
  getItem?: (key: string) => string | null,
): number {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return ZOOM_DEFAULT;
  let raw: string | null;
  try {
    raw = get(ZOOM_STORAGE_KEY);
  } catch {
    return ZOOM_DEFAULT;
  }
  if (raw === null) return ZOOM_DEFAULT;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return ZOOM_DEFAULT;
  return clamp(parsed);
}

function writeStoredZoom(next: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
  } catch {
    // Private-mode Safari / storage-full: swallow.
  }
}

/**
 * Apply the zoom factor to the document root. The token stylesheet reads
 * `--q-zoom` as a multiplier on `--q-font-size-base`. SSR / non-browser
 * environments skip silently — the DOM may not exist under vitest's
 * non-jsdom runners.
 */
export function applyZoomToDocument(value: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty('--q-zoom', String(value));
}

export const useZoomStore = create<ZoomStore>((set, get) => {
  const initial = readStoredZoom();
  // Apply on boot so a fresh mount reflects the persisted value without the
  // widget tree having to subscribe before paint.
  applyZoomToDocument(initial);
  return {
    zoomLevel: initial,
    zoomIn: () => {
      const next = clamp(get().zoomLevel + ZOOM_STEP);
      if (next === get().zoomLevel) return;
      writeStoredZoom(next);
      applyZoomToDocument(next);
      set({ zoomLevel: next });
    },
    zoomOut: () => {
      const next = clamp(get().zoomLevel - ZOOM_STEP);
      if (next === get().zoomLevel) return;
      writeStoredZoom(next);
      applyZoomToDocument(next);
      set({ zoomLevel: next });
    },
    reset: () => {
      if (get().zoomLevel === ZOOM_DEFAULT) return;
      writeStoredZoom(ZOOM_DEFAULT);
      applyZoomToDocument(ZOOM_DEFAULT);
      set({ zoomLevel: ZOOM_DEFAULT });
    },
    setZoom: (nextRaw) => {
      const next = clamp(nextRaw);
      if (next === get().zoomLevel) return;
      writeStoredZoom(next);
      applyZoomToDocument(next);
      set({ zoomLevel: next });
    },
  };
});
