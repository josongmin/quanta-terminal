/**
 * `cx` — tiny classname utility. Wraps `clsx` so if we ever swap the impl we
 * only change one file.
 */
import clsx from 'clsx';
import type { ClassValue } from 'clsx';

export function cx(...values: ClassValue[]): string {
  return clsx(...values);
}
