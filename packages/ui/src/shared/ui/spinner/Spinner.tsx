/**
 * Spinner — indeterminate progress primitive. Used by the terminal-page
 * loading state and any future async affordance (e.g. palette search).
 *
 * Accessibility: role="status" + aria-label so screen readers announce the
 * loading state without the visual element having to change. The visible
 * animation honors `prefers-reduced-motion` via the --q-dur-slow token.
 */

import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './spinner.module.css';

export type SpinnerSize = 'sm' | 'md';

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly size?: SpinnerSize;
  /** Announced label. Defaults to "Loading". */
  readonly label?: string;
}

export function Spinner(props: SpinnerProps) {
  const { size = 'md', label = 'Loading', className, ...rest } = props;
  return (
    <span
      role="status"
      aria-label={label}
      className={cx(styles.spinner, styles[`size-${size}`], className)}
      {...rest}
    >
      <span className={styles.ring} aria-hidden />
    </span>
  );
}

Spinner.displayName = 'Spinner';
