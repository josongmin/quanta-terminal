/**
 * BellFlash — visual flash overlay that reacts to bell events.
 *
 * Subscribes to `bellCount` from `useBellStore` and mounts a briefly-visible
 * overlay element each time the counter advances. The element is keyed by
 * `bellCount` so React remounts it on each bell, which restarts the CSS
 * keyframe animation from scratch.
 *
 * Honors `prefers-reduced-motion`:
 *   - Default: 80 ms fade keyframe via CSS.
 *   - Reduced motion: static low-alpha shade held for 80 ms, then removed
 *     via a timeout. No animation runs.
 *
 * Gate: the flash only renders when `visualBell` is enabled in settings.
 * Audio is handled separately in the terminal page wiring.
 */

import { useEffect, useState } from 'react';

import { useBellStore } from '../../entities/bell/index.js';
import { useBellSettings } from '../../features/bell/index.js';

import styles from './bell-flash.module.css';

/** How long the flash stays mounted, matched to the CSS keyframe. */
const FLASH_DURATION_MS = 80;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface BellFlashProps {
  /** Optional extra class — lets the parent position the absolute overlay. */
  readonly className?: string;
}

export function BellFlash(props: BellFlashProps): JSX.Element | null {
  const { className } = props;
  const visualBell = useBellSettings((s) => s.visualBell);
  const bellCount = useBellStore((s) => s.bellCount);
  // `activeSeq` is the bellCount that is currently being rendered (null
  // when nothing is flashing). We bump it on each advance, then clear it
  // after FLASH_DURATION_MS.
  const [activeSeq, setActiveSeq] = useState<number | null>(null);

  useEffect(() => {
    if (!visualBell) return;
    if (bellCount === 0) return;
    setActiveSeq(bellCount);
    const timer = setTimeout(() => {
      setActiveSeq((cur) => (cur === bellCount ? null : cur));
    }, FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [bellCount, visualBell]);

  if (!visualBell) return null;
  if (activeSeq === null) return null;

  const reduced = prefersReducedMotion();
  return (
    <div
      key={activeSeq}
      className={[styles.flash, styles.flashActive, className]
        .filter(Boolean)
        .join(' ')}
      data-testid="bell-flash"
      data-bell-seq={String(activeSeq)}
      data-reduced-motion={reduced ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}

BellFlash.displayName = 'BellFlash';
