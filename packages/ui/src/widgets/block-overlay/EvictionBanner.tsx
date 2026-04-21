/**
 * Plan 0005 P1-C polish — EvictionBanner.
 *
 * A small pill shown at the top of the BlockOverlay when the scrollback
 * ring is at capacity AND at least one pin has BLOCKED an eviction cycle.
 *
 * Copy: "Scrollback at capacity; oldest N rows pinned. Unpinning will
 * free ≈ X MB."
 *
 *   - `N` is the count of rows at the head that are currently pinned and
 *     therefore un-evictable. The banner does not show WHICH blocks own
 *     the pins — that is P2 work (unpin action).
 *   - `X` is an estimate derived from `(pinnedRowCount * bytesPerRow) /
 *     1_048_576`, where `bytesPerRow` is the product of cols × the
 *     internal-cell fixed cost. The estimate is NOT a hard guarantee;
 *     we'd rather underestimate and get "free at least X" semantics.
 *
 * Lifecycle
 * ---------
 * The banner is mounted by `BlockOverlayHost` conditional on
 * `pinBlockedEvictions > 0`. Once the pin is cleared AND an eviction
 * cycle has resumed (counter staying flat for at least one rAF), the
 * banner auto-dismisses with a short fade. The component self-manages its
 * "cooldown" timer so a momentary blip doesn't flash the UI.
 *
 * Hit-testing
 * -----------
 * `pointer-events: auto` on the pill so the future close button (P2) can
 * accept clicks without the overlay's `pointer-events: none` root
 * swallowing them. The pill currently has a dismiss "×" that just hides
 * the banner for the rest of the session — it is NOT an unpin action.
 *
 * A11y
 * ----
 * `role="status"` + `aria-live="polite"` so screen readers announce the
 * capacity warning once; we do not re-announce on counter bumps to avoid
 * speech spam during a flood.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { cx } from '../../shared/lib/cx.js';
import styles from './eviction-banner.module.css';

export interface EvictionBannerProps {
  /**
   * The live `pinBlockedEvictions` counter from the emulator scrollback.
   * The banner tracks the VALUE (monotonic) and transitions itself to
   * "visible" on the first increment, then "cooling" on the first tick
   * where the value stops increasing.
   */
  readonly pinBlockedEvictions: number;
  /**
   * How many rows at the head of the ring are currently pinned. Used for
   * the `"oldest N rows pinned"` copy. When `0`, the banner treats the
   * pin as "released" and auto-dismisses even if `pinBlockedEvictions`
   * never goes back down (it's a monotonic counter; release is a
   * different signal).
   */
  readonly pinnedRowCount: number;
  /**
   * Approximate bytes that would be freed if the pinned rows were
   * unpinned and evicted. Rendered as MB to one decimal; when `0` the
   * "will free" clause is omitted. Callers derive this from the ring's
   * internal row × cell cost; the banner does not compute it.
   */
  readonly freeableBytes: number;
  /**
   * Optional className slot, typically used by tests to anchor layout
   * assertions. The stylesheet is the authoritative source for visual
   * defaults.
   */
  readonly className?: string;
  /**
   * How long (ms) the banner stays "mounted" after the counter stops
   * increasing before it tears itself down. Defaults to 1500 ms; tests
   * inject shorter values so they don't have to tick for 1.5 s.
   */
  readonly cooldownMs?: number;
  /**
   * Optional test-only clock. Defaults to `() => Date.now()`.
   */
  readonly now?: () => number;
  /**
   * Optional test-only scheduler for the cooldown timer. Defaults to
   * `setTimeout`. Returns a handle the component stores and cancels on
   * unmount or when the counter bumps again.
   */
  readonly scheduler?: (cb: () => void, ms: number) => unknown;
  /** Test-only cancel for the cooldown timer. Defaults to `clearTimeout`. */
  readonly cancelScheduler?: (handle: unknown) => void;
}

const DEFAULT_COOLDOWN_MS = 1500;

/**
 * Format `bytes` as "X.Y MB" or "X KB" for the banner copy. Tiny utility
 * kept inline so the banner's copy stays in one place and is easy to
 * tweak. Negative / NaN → empty string.
 */
export function formatFreeableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const MB = 1024 * 1024;
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  const KB = 1024;
  if (bytes >= KB) {
    return `${Math.round(bytes / KB)} KB`;
  }
  return `${bytes} B`;
}

function defaultScheduler(cb: () => void, ms: number): unknown {
  return setTimeout(cb, ms);
}

function defaultCancel(handle: unknown): void {
  if (handle !== undefined && handle !== null) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/**
 * A small internal state machine:
 *
 *   hidden    – never seen a pin (or pinned count went back to 0 and
 *               cooldown elapsed).
 *   armed     – counter just incremented; banner is visible, cooldown is
 *               not yet armed.
 *   cooling   – counter has stopped changing; cooldown timer is ticking.
 *   hidden ← cooling after `cooldownMs`.
 *
 * The machine is intentionally tiny: the component doesn't track lengthy
 * history, and any future "flap-guard" behaviour belongs upstream in the
 * emulator or in a dedicated banner policy store (P2).
 */
type BannerPhase = 'hidden' | 'armed' | 'cooling';

export const EvictionBanner = memo(function EvictionBanner(
  props: EvictionBannerProps,
): JSX.Element | null {
  const {
    pinBlockedEvictions,
    pinnedRowCount,
    freeableBytes,
    className,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    now,
    scheduler = defaultScheduler,
    cancelScheduler = defaultCancel,
  } = props;
  // `now` is reserved for a future refinement where the cooldown is
  // measured against an armed-at timestamp (so a scheduler with
  // coarse-granularity timers still fires at the right moment). We keep
  // the prop in the contract for forward compatibility; the current
  // machine uses the scheduler's own timer.
  void now;

  // Initial phase derives from inputs: if the banner mounts with non-zero
  // signals, it enters `armed` synchronously. Zero-signal mounts stay
  // hidden until the first bump observed via the effect below.
  const initialPhase: BannerPhase =
    pinBlockedEvictions > 0 || pinnedRowCount > 0 ? 'armed' : 'hidden';
  const [phase, setPhase] = useState<BannerPhase>(initialPhase);
  // Track the last-observed counter value so we can detect an INCREASE
  // across renders. A fresh increment re-arms the banner and cancels any
  // in-flight cooldown. We initialise to the MOUNT value so the effect
  // below only reacts to transitions; the mount itself is handled by the
  // initial-phase derivation above.
  const [lastCount, setLastCount] = useState<number>(pinBlockedEvictions);
  // User-dismissed up to a given counter value. A later bump strictly
  // greater than this threshold re-shows the banner; same or lower keeps
  // it hidden. `null` = not dismissed.
  const [dismissedAtCount, setDismissedAtCount] = useState<number | null>(
    null,
  );

  const dismiss = useCallback(() => {
    setDismissedAtCount(pinBlockedEvictions);
    setPhase('hidden');
  }, [pinBlockedEvictions]);

  // Observe counter transitions.
  useEffect(() => {
    // Detect a fresh bump — re-arm and clear any user dismissal if the
    // new count exceeds the dismissed threshold.
    if (pinBlockedEvictions > lastCount) {
      if (
        dismissedAtCount !== null &&
        pinBlockedEvictions > dismissedAtCount
      ) {
        setDismissedAtCount(null);
      }
      setPhase('armed');
      setLastCount(pinBlockedEvictions);
      return;
    }
    // Counter flat but pins were released — begin cooldown (only when
    // already armed; cooling stays cooling).
    if (
      pinBlockedEvictions === lastCount &&
      phase === 'armed' &&
      pinnedRowCount === 0
    ) {
      setPhase('cooling');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinBlockedEvictions, pinnedRowCount, lastCount, dismissedAtCount]);

  // Cooldown timer.
  useEffect(() => {
    if (phase !== 'cooling') return;
    const handle = scheduler(() => {
      setPhase('hidden');
    }, cooldownMs);
    return () => cancelScheduler(handle);
  }, [phase, cooldownMs, scheduler, cancelScheduler]);

  const isVisible =
    phase !== 'hidden' &&
    dismissedAtCount === null &&
    // Defense-in-depth: don't render an empty banner when there are no
    // pins AND the counter is zero (first paint, nothing has happened
    // yet). The above state machine enforces this too but the guard keeps
    // the render path obvious.
    (pinnedRowCount > 0 || pinBlockedEvictions > 0);

  const freeableCopy = useMemo(
    () => formatFreeableBytes(freeableBytes),
    [freeableBytes],
  );

  if (!isVisible) return null;

  const message =
    pinnedRowCount > 0
      ? `Scrollback at capacity; oldest ${pinnedRowCount} row${
          pinnedRowCount === 1 ? '' : 's'
        } pinned.`
      : 'Scrollback at capacity.';

  const freeable = freeableCopy ? ` Unpinning will free ≈ ${freeableCopy}.` : '';

  return (
    <div
      className={cx(styles.banner, className)}
      data-testid="eviction-banner"
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <span className={styles.label} data-testid="eviction-banner-label">
        {message}
        {freeable}
      </span>
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        aria-label="Dismiss scrollback capacity warning"
        data-testid="eviction-banner-dismiss"
      >
        ×
      </button>
    </div>
  );
});

EvictionBanner.displayName = 'EvictionBanner';
