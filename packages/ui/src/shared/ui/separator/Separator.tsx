/**
 * Separator — thin 1px divider. Vertical by default; horizontal when the
 * orientation prop says so. Used in the composer (mode chip divider),
 * status bar, and palette sections.
 */

import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './separator.module.css';

export type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps extends HTMLAttributes<HTMLSpanElement> {
  readonly orientation?: SeparatorOrientation;
  /**
   * When true, announce to screen readers as an explicit separator. When
   * false (default), mark decorative via aria-hidden — most of our uses are
   * visual dividers in a flex row that carry no semantic meaning.
   */
  readonly semantic?: boolean;
}

export function Separator(props: SeparatorProps) {
  const {
    orientation = 'vertical',
    semantic = false,
    className,
    ...rest
  } = props;
  const ariaProps = semantic
    ? ({ role: 'separator', 'aria-orientation': orientation } as const)
    : ({ 'aria-hidden': true } as const);
  return (
    <span
      className={cx(styles.separator, styles[orientation], className)}
      {...ariaProps}
      {...rest}
    />
  );
}

Separator.displayName = 'Separator';
