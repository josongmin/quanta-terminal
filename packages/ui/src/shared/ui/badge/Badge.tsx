/**
 * Badge — ADR 0010 degraded-state primitive.
 *
 * Monospaced, border-only, no fill. Color tone is additive; the label always
 * carries the information. The aria-label mirrors the tooltip's first sentence.
 *
 * Every degraded state in the ADR taxonomy renders as a `<Badge>` with one of
 * the documented `label` strings (`est`, `detached`, `truncated`, etc.).
 */

import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Short one-word label. ADR 0010 lists the canonical values. */
  readonly label: string;
  /** Tone. Defaults to neutral; color is additive, never sole differentiator. */
  readonly tone?: BadgeTone;
  /** Sentence used as aria-label and surfaced to the Tooltip. */
  readonly srDescription?: string;
}

export function Badge(props: BadgeProps) {
  const { label, tone = 'neutral', srDescription, className, ...rest } = props;
  return (
    <span
      role="status"
      aria-label={srDescription ?? label}
      className={cx(styles.badge, styles[`tone-${tone}`], className)}
      {...rest}
    >
      {label}
    </span>
  );
}

Badge.displayName = 'Badge';
