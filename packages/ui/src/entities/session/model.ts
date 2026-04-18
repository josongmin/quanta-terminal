/**
 * Session entity — the UI's view of a terminal session.
 *
 * Holds: id, shell, cwd, truth-state of that cwd (per ADR 0003 / ADR 0010),
 * shell integration status, and health. The real values come from host bridge
 * events; Phase 1 seeds them from the spawn result.
 *
 * Store wiring
 * ------------
 * Wrapped in `subscribeWithSelector` so consumers outside React (e.g. the
 * session-connect feature) can subscribe to one slice efficiently. Widgets
 * should import selector helpers from `./selectors.ts` rather than reaching
 * into the whole state shape.
 *
 * The store is intentionally NOT persisted — it is per-process, per-session
 * derived state. Accidentally persisting would leak a stale `id` between
 * runs. A test in `selectors.test.ts` asserts this.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  CwdSource,
  SessionId,
  ShellIntegrationStatus,
} from '../../shared/types/generated/index.js';

export type SessionHealth = 'booting' | 'ready' | 'exited' | 'error';

export interface SessionState {
  readonly id: SessionId | null;
  readonly shell: string;
  readonly cwd: string;
  readonly cwdSource: CwdSource;
  readonly shellIntegration: ShellIntegrationStatus;
  readonly health: SessionHealth;
  readonly exitCode: number | null;
}

export interface SessionActions {
  setSession(patch: Partial<SessionState>): void;
  markExited(exitCode: number | null): void;
  reset(): void;
}

const INITIAL: SessionState = {
  id: null,
  shell: '',
  cwd: '',
  cwdSource: 'launch',
  shellIntegration: 'missing',
  health: 'booting',
  exitCode: null,
};

export const useSessionStore = create<SessionState & SessionActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL,
    setSession: (patch) => set((prev) => ({ ...prev, ...patch })),
    markExited: (exitCode) => set(() => ({ health: 'exited', exitCode })),
    reset: () => set(() => ({ ...INITIAL })),
  })),
);
