/**
 * Tooltip — ADR 0010 primitive. Used to explain what a badge means and link
 * to a concrete fix. Keyboard-accessible via :focus-within on the wrapper.
 *
 * Content is one sentence per copy discipline; the caller can add an action
 * link after it.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './tooltip.module.css';

export interface TooltipProps {
  /** The element that triggers the tooltip. Must be focusable for a11y. */
  readonly children: ReactNode;
  /** One-sentence explanation. */
  readonly content: ReactNode;
  readonly className?: string;
}

export function Tooltip(props: TooltipProps) {
  const { children, content, className } = props;
  const id = useId();
  return (
    <span className={cx(styles.wrap, className)} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className={styles.bubble}>
        {content}
        <span className={styles.arrow} aria-hidden />
      </span>
    </span>
  );
}

Tooltip.displayName = 'Tooltip';
