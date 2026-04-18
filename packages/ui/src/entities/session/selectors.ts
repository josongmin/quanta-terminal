/**
 * Session store selectors — curated slices for widgets.
 *
 * Problem this solves
 * -------------------
 * A naive widget that needs `shell`, `cwd`, `health`, `shellIntegration`, and
 * `exitCode` writes five `useSessionStore(s => s.field)` calls. Each call
 * subscribes to the whole store and re-renders the widget whenever ANY field
 * changes — even ones it didn't read. With `useShallow`, we pick an object
 * and re-render only when one of the chosen fields changes.
 *
 * Usage (e.g. StatusBar — adopt in Round 3):
 *   const s = useStatusBarSelector();
 *   // s is { shell, cwd, health, shellIntegration, exitCode }
 *
 * Extending
 * ---------
 * Add new selector hooks here, do NOT reach into the raw store from widgets.
 * Each selector's returned shape must be a plain object (no fns, no Maps); the
 * shallow compare cares about reference equality of the top-level fields only.
 */

import { useShallow } from 'zustand/react/shallow';
import { useSessionStore, type SessionHealth, type SessionState } from './model.js';
import type { ShellIntegrationStatus } from '../../shared/types/generated/index.js';

export interface StatusBarSlice {
  readonly shell: string;
  readonly cwd: string;
  readonly health: SessionHealth;
  readonly shellIntegration: ShellIntegrationStatus;
  readonly exitCode: number | null;
}

const pickStatusBar = (s: SessionState): StatusBarSlice => ({
  shell: s.shell,
  cwd: s.cwd,
  health: s.health,
  shellIntegration: s.shellIntegration,
  exitCode: s.exitCode,
});

/**
 * Everything the StatusBar widget reads. Returns a shallow-stable object so
 * unrelated store updates (e.g. `cwdSource` changing alone) do not re-render
 * the bar.
 */
export function useStatusBarSelector(): StatusBarSlice {
  return useSessionStore(useShallow(pickStatusBar));
}

/** Session id alone — used by features that need to guard by session. */
export function useSessionId(): SessionState['id'] {
  return useSessionStore((s) => s.id);
}

/** Health alone — used by the composer's disabled-state guard. */
export function useSessionHealth(): SessionHealth {
  return useSessionStore((s) => s.health);
}
