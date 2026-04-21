/**
 * GhostHint — Plan 0005 P1-G.
 *
 * Renders a subtle bottom-right pill suggesting the key binding that leaves
 * the current shell mode (less/man/python/node/tmux/vim/htop/psql/nested
 * shell). The mode is read from the `useModeStack` hook (shimmed locally
 * until P1-D lands on main); we pick the *topmost* layer that has a
 * registry entry so nested modes (vim inside tmux) show the innermost hint
 * first — that's the one the user actually needs to escape.
 *
 * Behaviour
 * ---------
 * - `opacity: 0.4` by default, `0.8` on hover / keyboard focus (CSS).
 * - Auto-dismisses after `autoDismissMs` (default 3000 ms) so the hint
 *   doesn't become visual noise once the user has settled into the mode.
 * - Re-shows whenever the top layer changes (the user pushed a new mode, or
 *   popped into a different one) — tracked via a synthesized "stack key"
 *   so `useEffect` fires reliably.
 *
 * Accessibility
 * -------------
 * - `role="status"` + `aria-live="polite"` — announced non-intrusively.
 * - `tabIndex={0}` and `aria-label` — focusable by keyboard navigation so
 *   screen readers can re-visit the hint without mouse hover.
 * - Clicking the pill does NOT send the key. Passive by design (see
 *   `hint-registry.ts`). Clicking merely dismisses the local auto-timer so
 *   a curious user can tab to the pill and have it stay visible.
 *
 * Feature-flag coexistence
 * ------------------------
 * - `flag.blockUx` only gates the block-list chrome (RFC §5). Ghost hints
 *   are orthogonal: they sit on top of the terminal canvas regardless of
 *   that flag. We therefore don't read the flag here — the component is
 *   safe to render under both `true` and `false`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../shared/lib/cx.js';
import { getGhostHint, type GhostHintEntry } from './hint-registry.js';
import { useModeStack as defaultUseModeStack, type ModeStackSnapshot } from './useModeStack.js';
import styles from './ghost-hint.module.css';

/** Default auto-dismiss in milliseconds. Exposed for tests. */
export const DEFAULT_AUTO_DISMISS_MS = 3000;

export interface GhostHintProps {
  /**
   * Hook used to read the mode stack. Defaults to the local shim; tests
   * and the real P1-D integration override it without patching imports.
   */
  readonly stackHook?: () => ModeStackSnapshot;
  /** Ms before the hint fades out. Reset on mode push. Default 3000. */
  readonly autoDismissMs?: number;
  /** Optional className passthrough for host integration. */
  readonly className?: string;
}

/**
 * Pick the topmost mode layer that has a registry entry. Layers without a
 * known ghost-hint kind (AI, composer, …) are skipped — we never render
 * an unknown hint with a generic fallback because an incorrect affordance
 * is worse than no affordance.
 */
function pickTopHint(
  snapshot: ModeStackSnapshot,
): { readonly key: string; readonly entry: GhostHintEntry } | null {
  const layers = snapshot.layers;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (!layer) continue;
    const entry = getGhostHint(layer.kind);
    if (entry) return { key: layer.kind, entry };
  }
  return null;
}

export function GhostHint(props: GhostHintProps): JSX.Element | null {
  const {
    stackHook = defaultUseModeStack,
    autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
    className,
  } = props;
  const snapshot = stackHook();
  const top = useMemo(() => pickTopHint(snapshot), [snapshot]);

  // Track the active hint key — a change resets the auto-dismiss timer.
  // `null` when the stack is empty / has no mapped hint.
  const activeKey = top?.key ?? null;

  // `dismissed` flips to true after the auto-dismiss window expires. A new
  // key (mode push) or hover re-show resets it.
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending auto-dismiss timer. Idempotent; safe to call from
  // cleanup, from the key-change effect, and from the hover handler.
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Whenever the active hint changes (including going from null -> X),
    // re-show the pill and arm a fresh auto-dismiss timer. Going X -> null
    // simply unmounts the pill; no timer needed.
    clearTimer();
    if (activeKey === null) {
      setDismissed(false);
      return;
    }
    setDismissed(false);
    if (autoDismissMs <= 0) {
      // `0` (or negative) disables auto-dismiss — useful for tests and for
      // users who prefer a persistent hint.
      return;
    }
    timerRef.current = setTimeout(() => {
      setDismissed(true);
      timerRef.current = null;
    }, autoDismissMs);
    return clearTimer;
  }, [activeKey, autoDismissMs, clearTimer]);

  // Hover / focus re-shows the hint (cancels the auto-dismiss). The CSS
  // already boosts opacity to 0.8 on :hover; this handler keeps the pill
  // visible if the auto-dismiss has already fired.
  const handleReveal = useCallback(() => {
    clearTimer();
    setDismissed(false);
  }, [clearTimer]);

  // Nothing to render when the stack is empty or has no mapped top layer.
  if (!top) return null;

  const { entry } = top;
  const ariaLabel = `Hint: ${entry.text}`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      tabIndex={0}
      data-testid="ghost-hint"
      data-kind={activeKey ?? ''}
      data-dismissed={dismissed ? 'true' : 'false'}
      className={cx(styles['ghost'], className)}
      onMouseEnter={handleReveal}
      onFocus={handleReveal}
    >
      <span className={styles['keys']}>{entry.text}</span>
    </div>
  );
}

GhostHint.displayName = 'GhostHint';
