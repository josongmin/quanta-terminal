/**
 * RiskGate — modal approval surface for Caution+ commands.
 *
 * Per the task's approval flow:
 *   - Caution: Enter to confirm.
 *   - Destructive: user must type the exact command to confirm (typed-to-
 *     confirm), then press Enter.
 *   - Blocked: render a red-banner state that cannot be approved, only
 *     dismissed.
 *
 * The gate is fully controlled: the caller passes `suggestion`, `onApprove`,
 * `onReject`. It reads no global state directly so the component is trivial
 * to snapshot-test.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { cx } from '../../shared/lib/cx.js';
import { selectTierLabel, type AiSuggestion } from '../../entities/ai/index.js';
import styles from './risk-gate.module.css';

export interface RiskGateProps {
  readonly suggestion: AiSuggestion | null;
  readonly onApprove: (s: AiSuggestion) => void;
  readonly onReject: (s: AiSuggestion) => void;
}

export function RiskGate(props: RiskGateProps) {
  const { suggestion, onApprove, onReject } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typedInputRef = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState('');

  // Focus-trap + state reset each time a fresh suggestion opens the gate.
  useEffect(() => {
    if (!suggestion) return;
    setTyped('');
    const container = containerRef.current;
    if (!container) return;
    const trap = activateFocusTrap(container);
    // Typed-to-confirm destructive rows autofocus the input; Caution
    // suggestions focus the container so Enter resolves directly.
    if (suggestion.classified.tier === 'destructive') {
      typedInputRef.current?.focus();
    } else {
      container.focus();
    }
    return () => trap.deactivate();
  }, [suggestion]);

  const canApprove = useMemo(() => {
    if (!suggestion) return false;
    if (suggestion.classified.tier === 'blocked') return false;
    if (suggestion.classified.tier === 'destructive') {
      return typed === suggestion.classified.command;
    }
    return true;
  }, [suggestion, typed]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!suggestion) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onReject(suggestion);
        return;
      }
      if (e.key === 'Enter' && canApprove) {
        e.preventDefault();
        onApprove(suggestion);
      }
    },
    [suggestion, canApprove, onApprove, onReject],
  );

  if (!suggestion) return null;

  const { tier, command, modifiers } = suggestion.classified;
  const blocked = tier === 'blocked';
  const destructive = tier === 'destructive';

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-testid="risk-gate-backdrop"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="risk-gate-title"
        aria-describedby="risk-gate-body"
        className={cx(styles.panel, blocked && styles.panelBlocked, destructive && styles.panelDestructive)}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.header}>
          <span className={styles.tierBadge} data-tier={tier}>
            {selectTierLabel(tier)}
          </span>
          <h2 id="risk-gate-title" className={styles.title}>
            {blocked
              ? 'This command is blocked'
              : destructive
                ? 'Destructive command — type to confirm'
                : 'Review this command'}
          </h2>
        </div>
        <pre id="risk-gate-body" className={styles.command}>
          {command}
        </pre>
        {modifiers.length > 0 ? (
          <ul className={styles.modifiers} aria-label="Why this tier">
            {modifiers.map((m) => (
              <li key={m} className={styles.modifier}>
                {m}
              </li>
            ))}
          </ul>
        ) : null}
        {destructive && !blocked ? (
          <label className={styles.typedRow}>
            <span className={styles.typedLabel}>
              Type the command exactly to confirm:
            </span>
            <input
              ref={typedInputRef}
              type="text"
              className={styles.typedInput}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type command to confirm"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              data-testid="risk-gate-typed-input"
            />
          </label>
        ) : null}
        <div className={styles.actions}>
          {blocked ? (
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => onReject(suggestion)}
              data-testid="risk-gate-dismiss"
            >
              Dismiss <Kbd>Esc</Kbd>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => onReject(suggestion)}
                data-testid="risk-gate-cancel"
              >
                Cancel <Kbd>Esc</Kbd>
              </button>
              <button
                type="button"
                className={styles.approveButton}
                onClick={() => onApprove(suggestion)}
                disabled={!canApprove}
                data-testid="risk-gate-approve"
              >
                Approve <Kbd>Enter</Kbd>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

RiskGate.displayName = 'RiskGate';
