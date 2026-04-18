/**
 * SuggestionBar — passive chrome above the composer.
 *
 * Responsibilities:
 *   - Show the current AI suggestion (command + one-line rationale + tier
 *     badge). Hidden when there is no suggestion or the risk gate is open.
 *   - Tab: accept the suggestion. For Safe commands "accept" means emit the
 *     `onAccept` callback and let the caller wire execution. For Caution+
 *     commands "accept" opens the risk gate via the entities/ai store and
 *     the caller renders a <RiskGate /> elsewhere (usually at the page root).
 *   - Esc: reject the suggestion. Records a `rejected` decision in the
 *     history.
 *
 * The widget is intentionally "passive" in the FSD sense: it reads from
 * the store and calls small pure helpers; it does not own the provider
 * call, the execution dispatch, or the gate mount point. Those belong to
 * the page-level composer wiring.
 */

import { useCallback, useEffect } from 'react';

import {
  useAiStore,
  selectShouldShowBar,
  selectTierLabel,
  type AiSuggestion,
} from '../../entities/ai/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './suggestion-bar.module.css';

export interface SuggestionBarProps {
  /**
   * Called when the user accepts a Safe suggestion via Tab. The widget
   * itself does NOT call this for Caution+ suggestions — those open the
   * risk gate via the store instead.
   */
  readonly onAccept?: (s: AiSuggestion) => void;
  /**
   * Called after the user rejects the suggestion via Esc. The widget has
   * already updated the store; the callback is a hook for the caller to,
   * e.g., focus the composer.
   */
  readonly onReject?: (s: AiSuggestion) => void;
  /**
   * Optional keyboard-shortcut host. Defaults to `window`; tests pass a
   * ref-less container so the widget is self-contained.
   */
  readonly keyboardTarget?: HTMLElement | null;
}

export function SuggestionBar(props: SuggestionBarProps) {
  const { onAccept, onReject, keyboardTarget } = props;
  const suggestion = useAiStore((s) => s.currentSuggestion);
  const visible = useAiStore(selectShouldShowBar);
  const openApproval = useAiStore((s) => s.openApproval);
  const recordDecision = useAiStore((s) => s.recordDecision);
  const setSuggestion = useAiStore((s) => s.setSuggestion);

  const accept = useCallback(
    (s: AiSuggestion) => {
      if (s.classified.tier === 'safe') {
        recordDecision(s, 'approved');
        setSuggestion(null);
        onAccept?.(s);
        return;
      }
      // Caution / Destructive / Blocked: open the gate and let the page
      // render the <RiskGate /> modal. Blocked is handled by the gate too —
      // it renders a dismiss-only surface per the flow contract.
      openApproval(s);
    },
    [openApproval, recordDecision, setSuggestion, onAccept],
  );

  const reject = useCallback(
    (s: AiSuggestion) => {
      recordDecision(s, 'rejected');
      setSuggestion(null);
      onReject?.(s);
    },
    [recordDecision, setSuggestion, onReject],
  );

  // Global Tab/Esc binding. We listen on `keyboardTarget` (default: window)
  // at the capture phase so the composer textarea doesn't swallow Tab. The
  // listener only triggers when a suggestion is visible — otherwise Tab
  // keeps its native tab-order meaning.
  useEffect(() => {
    if (!visible || !suggestion) return;
    const target: EventTarget =
      keyboardTarget ?? (typeof window !== 'undefined' ? window : globalThis);
    const handler = (raw: Event) => {
      const e = raw as KeyboardEvent;
      if (e.defaultPrevented) return;
      if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        accept(suggestion);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        reject(suggestion);
      }
    };
    target.addEventListener('keydown', handler as EventListener, true);
    return () => {
      target.removeEventListener('keydown', handler as EventListener, true);
    };
  }, [visible, suggestion, keyboardTarget, accept, reject]);

  if (!visible || !suggestion) return null;

  const { tier, command, modifiers } = suggestion.classified;
  return (
    <div
      className={cx(styles.bar, tier !== 'safe' && styles.barWarn)}
      role="complementary"
      aria-label="AI suggestion"
      data-testid="suggestion-bar"
      data-tier={tier}
    >
      <span className={styles.badge} data-tier={tier}>
        {selectTierLabel(tier)}
      </span>
      <code className={styles.command}>{command}</code>
      {suggestion.rationale ? (
        <span className={styles.rationale}>{suggestion.rationale}</span>
      ) : null}
      {modifiers.length > 0 ? (
        <span className={styles.modifierCount} title={modifiers.join(', ')}>
          {modifiers.length} {modifiers.length === 1 ? 'modifier' : 'modifiers'}
        </span>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.acceptButton}
          onClick={() => accept(suggestion)}
          data-testid="suggestion-bar-accept"
        >
          Accept <Kbd>Tab</Kbd>
        </button>
        <button
          type="button"
          className={styles.rejectButton}
          onClick={() => reject(suggestion)}
          data-testid="suggestion-bar-reject"
        >
          Reject <Kbd>Esc</Kbd>
        </button>
      </div>
    </div>
  );
}

SuggestionBar.displayName = 'SuggestionBar';
