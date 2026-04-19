/**
 * Notification settings store — the user's preference for whether to post
 * OS notifications on long-running command completion, and the threshold
 * (in milliseconds) above which a command qualifies as "long-running".
 *
 * Persisted to localStorage. Defaults: enabled=true, threshold=10_000ms
 * (10s). The detector module reads these values per-block when deciding
 * whether to dispatch.
 */

import { create } from 'zustand';

export const NOTIFY_STORAGE_KEY = 'quanta:notify';
export const DEFAULT_LONG_RUN_THRESHOLD_MS = 10_000;
export const MIN_LONG_RUN_THRESHOLD_MS = 1_000;
export const MAX_LONG_RUN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface NotifySettings {
  readonly enabled: boolean;
  readonly longRunThresholdMs: number;
}

export interface NotifySettingsStore extends NotifySettings {
  readonly setEnabled: (next: boolean) => void;
  readonly setThresholdMs: (nextMs: number) => void;
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LONG_RUN_THRESHOLD_MS;
  return Math.max(MIN_LONG_RUN_THRESHOLD_MS, Math.min(MAX_LONG_RUN_THRESHOLD_MS, Math.round(value)));
}

export function readStoredSettings(
  getItem?: (key: string) => string | null,
): NotifySettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return { enabled: true, longRunThresholdMs: DEFAULT_LONG_RUN_THRESHOLD_MS };
  let raw: string | null;
  try {
    raw = get(NOTIFY_STORAGE_KEY);
  } catch {
    return { enabled: true, longRunThresholdMs: DEFAULT_LONG_RUN_THRESHOLD_MS };
  }
  if (raw === null) return { enabled: true, longRunThresholdMs: DEFAULT_LONG_RUN_THRESHOLD_MS };
  try {
    const parsed = JSON.parse(raw) as Partial<NotifySettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      longRunThresholdMs:
        typeof parsed.longRunThresholdMs === 'number'
          ? clampThreshold(parsed.longRunThresholdMs)
          : DEFAULT_LONG_RUN_THRESHOLD_MS,
    };
  } catch {
    return { enabled: true, longRunThresholdMs: DEFAULT_LONG_RUN_THRESHOLD_MS };
  }
}

function writeStored(next: NotifySettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode Safari / storage full: swallow.
  }
}

export const useNotifySettings = create<NotifySettingsStore>((set, get) => {
  const initial = readStoredSettings();
  return {
    ...initial,
    setEnabled: (next) => {
      if (get().enabled === next) return;
      const ns: NotifySettings = {
        enabled: next,
        longRunThresholdMs: get().longRunThresholdMs,
      };
      writeStored(ns);
      set({ enabled: next });
    },
    setThresholdMs: (nextMs) => {
      const clamped = clampThreshold(nextMs);
      if (clamped === get().longRunThresholdMs) return;
      const ns: NotifySettings = {
        enabled: get().enabled,
        longRunThresholdMs: clamped,
      };
      writeStored(ns);
      set({ longRunThresholdMs: clamped });
    },
  };
});
