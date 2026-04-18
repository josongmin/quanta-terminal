/** Kbd — stylized keyboard key. Used in tooltips and hints. */

import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './kbd.module.css';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  readonly children: string;
}

export function Kbd(props: KbdProps) {
  const { children, className, ...rest } = props;
  return (
    <kbd className={cx(styles.kbd, className)} {...rest}>
      {children}
    </kbd>
  );
}

Kbd.displayName = 'Kbd';
