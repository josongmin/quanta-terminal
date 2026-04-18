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
 *
 * Phase 4 additions
 * -----------------
 * `useSessionTabs` / `useActiveSessionTabLabel` read from the multi-session
 * collection (`useSessionsStore`) to power the SessionTabs widget. The
 * StatusBar keeps reading from the singular mirror — it always shows the
 * active session, so the mirror is the correct source.
 */

import { useShallow } from 'zustand/react/shallow';
import { useSessionStore, type SessionHealth, type SessionState } from './model.js';
import { useSessionsStore, type SessionEntity } from './sessions-store.js';
import type { SessionId, ShellIntegrationStatus } from '../../shared/types/generated/index.js';

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

/**
 * Per-tab view object — one row of the SessionTabs widget.
 *
 * Kept intentionally minimal: the tab chrome only needs the id (for `key` and
 * click targeting), a display label (shell basename + short cwd), the full
 * shell + cwd strings for the `aria-label` / tooltip, and the health dot.
 * Fields are primitives so the shallow compare over the list is meaningful.
 */
export interface SessionTabView {
  readonly id: SessionId;
  readonly shell: string;
  readonly cwd: string;
  readonly health: SessionHealth;
  readonly isActive: boolean;
}

/**
 * Ordered list of tab views, one per known session. Shallow-compared so the
 * widget only re-renders when the tab rows actually change shape (add/remove,
 * active swap, shell/cwd text change per session). Internal edits that don't
 * touch the surfaced fields (e.g. `cwdSource`, `exitCode`) do not trigger.
 */
export function useSessionTabs(): readonly SessionTabView[] {
  return useSessionsStore(
    useShallow((s) => {
      const active = s.activeId;
      const out: SessionTabView[] = [];
      for (const id of s.order) {
        const e: SessionEntity | undefined = s.entities[id];
        if (!e) continue;
        out.push({
          id: e.id,
          shell: e.shell,
          cwd: e.cwd,
          health: e.health,
          isActive: active === e.id,
        });
      }
      return out;
    }),
  );
}

/**
 * Active tab's short label ("zsh · ~/project"). Used by the StatusBar and
 * the (sole) active session's hover tooltip. Returns `undefined` when no
 * session is active yet.
 */
export function useActiveSessionTabLabel(): string | undefined {
  return useSessionsStore((s) => {
    if (s.activeId === null) return undefined;
    const e = s.entities[s.activeId];
    if (!e) return undefined;
    const shell = basename(e.shell) ?? e.shell;
    const cwd = shortCwd(e.cwd);
    if (shell && cwd) return `${shell} · ${cwd}`;
    return shell || cwd || undefined;
  });
}

function basename(p: string): string | undefined {
  if (!p) return undefined;
  const b = p.split('/').filter(Boolean).pop();
  return b;
}

function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/u.exec(cwd);
  if (m) return '~' + (m[2] ?? '');
  return cwd;
}
