/**
 * Banner — ADR 0010 session/block-level strip. One line, one primary action,
 * one dismiss. Dismissal is per-session (the caller wires persistence).
 *
 * Callers are responsible for enforcing the precedence queue
 *   crash > quota > secret rescan > shell integration
 * so that at most one Banner ever renders at a time.
 */

import type { ReactNode } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './banner.module.css';

export type BannerKind = 'info' | 'warning' | 'danger';

export interface BannerProps {
  readonly kind?: BannerKind;
  readonly children: ReactNode;
  /** Primary action. Reuse the Button primitive. */
  readonly action?: ReactNode;
  /** Dismiss handler. If omitted, the dismiss control is hidden. */
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly className?: string;
}

export function Banner(props: BannerProps) {
  const { kind = 'info', children, action, onDismiss, dismissLabel = 'Dismiss', className } = props;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(styles.banner, styles[`kind-${kind}`], className)}
    >
      <div className={styles.text}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          {dismissLabel}
        </button>
      ) : null}
    </div>
  );
}

Banner.displayName = 'Banner';
