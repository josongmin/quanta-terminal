/**
 * `PreeditOverlay` — pure view component rendering the IME preedit text.
 * EPIC-E §6 / ADR 0018.
 *
 * Props-driven; no internal state. Position is absolute relative to the
 * terminal container, computed by the caller from (row, col) and
 * optionally pre-computed (x, y) pixel offsets (EPIC-D renderer supplies
 * `cellToScreen()` at integration time; until then the caller passes x/y
 * directly).
 *
 * Invariant I-7 (preedit never enters grid) is enforced by the fact that
 * this component does NOT import from `shared/lib/grid-mirror/**`.
 */
import { useEffect, useRef } from 'react';

import type { PreeditOverlayProps } from './ime-types';

/** Unit test-facing re-export of the props type. */
export type { PreeditOverlayProps };

export function PreeditOverlay(props: PreeditOverlayProps): JSX.Element {
  const { text, anchor, dimmed, onMeasure } = props;
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!onMeasure || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    onMeasure(rect);
  }, [text, anchor.row, anchor.col, anchor.x, anchor.y, onMeasure]);

  const style: React.CSSProperties = {
    position: 'absolute',
    left: anchor.x ?? 0,
    top: anchor.y ?? 0,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'inherit',
    background: 'transparent',
    textDecoration: 'underline',
    whiteSpace: 'pre',
    pointerEvents: dimmed ? 'none' : 'auto',
    opacity: dimmed ? 0.5 : 1,
    // Below selection (EPIC-D §14.1), above cursor overlay.
    zIndex: 5,
  };

  return (
    <span
      ref={ref}
      className="quanta-preedit-overlay"
      role="presentation"
      aria-label="ime-preedit"
      data-row={anchor.row}
      data-col={anchor.col}
      data-dimmed={dimmed ? 'true' : 'false'}
      style={style}
    >
      {text}
    </span>
  );
}
