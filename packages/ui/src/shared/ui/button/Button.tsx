/**
 * Button — primitive used by banners, tooltips, status bar, etc.
 *
 * Ghost by default. Primary for affirmative actions. Destructive is not a
 * Phase-1 variant; risky commands go through the suggestion-review widget.
 */

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const { variant = 'default', className, type = 'button', ...rest } = props;
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        variant !== 'default' && styles[`variant-${variant}`],
        className,
      )}
      {...rest}
    />
  );
});
