/**
 * Toast store — ephemeral, auto-dismissed user notifications.
 *
 * Why this is separate from `entities/banner`:
 *   - Banners are a fixed taxonomy (crash, quota, secret_rescan, shell_integration)
 *     with precedence rules and session-scoped dismissal state.
 *   - Toasts are free-form, short-lived (~4s), stacked, and driven by
 *     user-initiated actions that can fail transiently ("open in editor
 *     didn't respond", "copy failed"). They are NOT modal and do NOT need
 *     precedence — they stack FIFO.
 *
 * Audit P1 (fix 5): the diagnostic-click → open-in-editor failure path was
 * silently swallowed. This store is the minimal surface for the callsite in
 * BlockCard to dispatch a short-lived toast.
 *
 * Layer: `shared/ui` — purely UI-concerned state, no cross-feature domain
 * knowledge. Features and widgets can both push toasts; the toast host
 * widget renders them.
 */

import { create } from 'zustand';

export type ToastKind = 'info' | 'warning' | 'danger';

export interface Toast {
  /** Monotonically increasing id — used as React key. */
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  /** Auto-dismiss delay in ms. 0 / negative means manual-only. */
  readonly durationMs: number;
}

export interface ToastState {
  readonly items: readonly Toast[];
}

export interface ToastActions {
  /** Push a toast. Returns its id so the caller can dismiss early. */
  pushToast(input: Omit<Toast, 'id'>): number;
  /** Dismiss by id. No-op for unknown ids. */
  dismissToast(id: number): void;
  /** Test helper — wipe everything. */
  clearAll(): void;
}

let nextId = 1;

export const DEFAULT_TOAST_DURATION_MS = 4000;

export const useToastStore = create<ToastState & ToastActions>((set) => ({
  items: [],
  pushToast: (input) => {
    const id = nextId;
    nextId += 1;
    const toast: Toast = { id, ...input };
    set((prev) => ({ items: [...prev.items, toast] }));
    return id;
  },
  dismissToast: (id) =>
    set((prev) => {
      const next = prev.items.filter((t) => t.id !== id);
      if (next.length === prev.items.length) return prev;
      return { items: next };
    }),
  clearAll: () => set(() => ({ items: [] })),
}));

/**
 * Convenience wrapper that pushes AND schedules auto-dismiss. Most callers
 * want this (fire-and-forget); tests that need precise control over timing
 * can push directly and call `dismissToast` manually.
 *
 * Returns the toast id for early-dismiss; the timer is cleared automatically
 * on manual dismiss by the host (not here — here we only schedule).
 */
export function showToast(input: {
  kind: ToastKind;
  message: string;
  durationMs?: number;
}): number {
  const durationMs = input.durationMs ?? DEFAULT_TOAST_DURATION_MS;
  const id = useToastStore.getState().pushToast({
    kind: input.kind,
    message: input.message,
    durationMs,
  });
  if (durationMs > 0) {
    setTimeout(() => {
      useToastStore.getState().dismissToast(id);
    }, durationMs);
  }
  return id;
}
