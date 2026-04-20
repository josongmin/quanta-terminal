/**
 * Tooltip — ADR 0010 primitive. Used to explain what a badge means and link
 * to a concrete fix. Keyboard-accessible via focus on the wrapper.
 *
 * Content is one sentence per copy discipline; the caller can add an action
 * link after it.
 *
 * Portal rendering
 * ----------------
 * The bubble is portaled to `document.body` so it can escape any ancestor
 * `overflow: hidden` / stacking-context trap (most notably the BlockCard's
 * rounded-corner clip which previously sliced the top of the bubble off).
 * We position with `position: fixed` using the trigger's
 * `getBoundingClientRect()`, and re-measure on show + scroll + resize so the
 * bubble tracks the trigger through virtualized list scrolling.
 *
 * The bubble element is ALWAYS in the DOM (hidden when not open) so
 * `aria-describedby` keeps resolving to a valid node for assistive tech, and
 * test queries like `getByRole('tooltip', { hidden: true })` continue to
 * work.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
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

interface BubblePosition {
  readonly top: number;
  readonly left: number;
}

/** Gap in px between the trigger's top edge and the bubble's bottom edge. */
const BUBBLE_GAP_PX = 6;

export function Tooltip(props: TooltipProps) {
  const { children, content, className } = props;
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<BubblePosition | null>(null);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  // Only mount the portal on the client — guards SSR / non-DOM environments.
  const canPortal = typeof document !== 'undefined';

  // Re-measure the bubble position relative to the trigger. Called on show
  // and whenever the viewport/scroll ancestors move while open.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;
    const triggerRect = wrap.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    // Center the bubble horizontally over the trigger. Clamp to the viewport
    // so the bubble doesn't run off the left / right edge on compact screens.
    const viewportWidth =
      typeof window !== 'undefined' ? window.innerWidth : triggerRect.right;
    const half = bubbleRect.width / 2;
    const centerX = triggerRect.left + triggerRect.width / 2;
    let left = centerX - half;
    // 4px minimum viewport inset matches the overlay shadow discipline.
    const INSET = 4;
    if (left < INSET) left = INSET;
    if (left + bubbleRect.width > viewportWidth - INSET) {
      left = Math.max(INSET, viewportWidth - INSET - bubbleRect.width);
    }
    const top = triggerRect.top - bubbleRect.height - BUBBLE_GAP_PX;
    setPos({ top, left });
  }, []);

  // Measure AFTER the bubble has been rendered with `open=true` (so it has a
  // size to measure). `useLayoutEffect` so the first paint is at the correct
  // coordinates rather than a flicker at (0,0).
  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure]);

  // While open, keep the bubble anchored to the trigger through scroll and
  // resize — critical for the block list which virtualizes and scrolls
  // frequently.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => measure();
    const onResize = () => measure();
    // `capture: true` so we hear scroll events on ANY ancestor scroll
    // container (the block list's `.scroll` div, for instance), not just the
    // window.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, measure]);

  const bubble = (
    <span
      ref={bubbleRef}
      role="tooltip"
      id={id}
      className={styles.bubble}
      data-open={open ? 'true' : 'false'}
      // `position: fixed` is applied inline because the element is portaled
      // to document.body — the module CSS class keeps visuals, but the
      // geometry is per-instance.
      style={
        pos && open
          ? {
              position: 'fixed',
              top: `${pos.top}px`,
              left: `${pos.left}px`,
              transform: 'none',
            }
          : undefined
      }
    >
      {content}
      <span className={styles.arrow} aria-hidden />
    </span>
  );

  return (
    <span
      ref={wrapRef}
      className={cx(styles.wrap, className)}
      aria-describedby={id}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {canPortal ? createPortal(bubble, document.body) : bubble}
    </span>
  );
}

Tooltip.displayName = 'Tooltip';
