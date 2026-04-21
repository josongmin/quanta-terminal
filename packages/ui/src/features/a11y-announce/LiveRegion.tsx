/**
 * `<LiveRegion />` — the visually-hidden aria-live container the
 * output-announcer hook writes into.
 *
 * Rendering rules
 * ---------------
 *   - Always mounted when the feature flag is on. Unmounting would cause AT
 *     focus churn; we just set `aria-live="off"` when the user picks "off".
 *   - The content clears itself 500 ms after being set so repeated IDENTICAL
 *     messages re-announce (screen readers typically suppress back-to-back
 *     duplicate node text; clearing forces them to treat the next update as
 *     a fresh utterance).
 *   - `aria-atomic="false"` — the region grows line-by-line; we don't want
 *     the AT to repeat already-announced prefix each time.
 *
 * The inline style matches the pattern used by the alt-screen announcer in
 * TerminalPage (which lives in the page's CSS module) so both live regions
 * have identical visual-hidden semantics.
 */

import { useEffect, useRef, useState } from 'react';
import { useOutputAnnouncer } from './useOutputAnnouncer.js';

/**
 * After an announcement lands, we clear the DOM text in this many ms so a
 * repeat of the same message still fires a fresh a11y event. 500 ms is long
 * enough for every mainstream screen reader to consume the current text
 * (NVDA, JAWS, VoiceOver, Orca) and short enough to not miss back-to-back
 * events.
 */
export const LIVE_REGION_CLEAR_MS = 500;

/** Visually-hidden CSS. Must not use `display:none` or `visibility:hidden`
 *  (both cause the AT to skip the region). The clip-path idiom keeps the
 *  element screen-reader-accessible while zero-width in layout. */
const HIDDEN_STYLE: Readonly<React.CSSProperties> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function LiveRegion() {
  const { mode, message } = useOutputAnnouncer();
  const [displayed, setDisplayed] = useState('');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (message.length === 0) return;
    setDisplayed(message);
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setDisplayed('');
    }, LIVE_REGION_CLEAR_MS);
  }, [message]);

  useEffect(
    () => () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    },
    [],
  );

  // aria-live="off" makes the region inert. We still render the node so that
  // toggling the feature on doesn't cause a mount/remount that some screen
  // readers treat as a focus event.
  return (
    <div
      role="status"
      aria-live={mode}
      aria-atomic="false"
      aria-relevant="additions text"
      style={HIDDEN_STYLE}
      data-testid="a11y-output-announcer"
      data-a11y-mode={mode}
    >
      {displayed}
    </div>
  );
}

LiveRegion.displayName = 'LiveRegion';
