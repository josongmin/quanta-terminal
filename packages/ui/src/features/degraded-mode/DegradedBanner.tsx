/**
 * DegradedBanner — last-resort banner rendered when the engine is dead.
 *
 * Per RFC §20 and ADR 0010 §Banner Triggers:
 *   - Shown only when `state === 'degraded'`.
 *   - Copy is pulled from the localization table (`degraded.engine_crashed`).
 *   - Single action: `Restart session`. No dismiss — dismissing while the
 *     engine is still dead produces the black-screen failure mode §20 forbids.
 *   - The button is disabled during the restart RPC so a double-click doesn't
 *     kick off two restarts.
 *
 * Consumers subscribe to `useDegradedMode()` for the state tuple; this
 * component is a pure presentational wrapper. The `onRestart` handler is
 * plumbed in by TerminalPage so the banner doesn't itself depend on the
 * session-tabs feature (keeps the FSD layering clean).
 */

import { useCallback, useState, type MouseEvent } from 'react';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import styles from './degraded-banner.module.css';

export interface DegradedBannerProps {
  readonly reason?: string | undefined;
  readonly onRestart: () => void | Promise<void>;
  readonly className?: string | undefined;
}

export function DegradedBanner(props: DegradedBannerProps): JSX.Element {
  const { reason, onRestart, className } = props;
  const [restarting, setRestarting] = useState(false);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (restarting) return;
      setRestarting(true);
      try {
        const result = onRestart();
        if (result && typeof (result as Promise<void>).finally === 'function') {
          void (result as Promise<void>).finally(() => setRestarting(false));
        } else {
          // Synchronous restart — reset the flag on the next microtask so a
          // rapid re-render doesn't reveal the disabled state for longer than
          // the user can perceive.
          queueMicrotask(() => setRestarting(false));
        }
      } catch {
        setRestarting(false);
      }
    },
    [onRestart, restarting],
  );

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-label={t('degraded.banner.ariaLabel')}
      className={cx(styles.banner, className)}
      data-testid="degraded-banner"
      data-reason={reason ?? 'engine_crashed'}
    >
      <span className={styles.message}>{t('degraded.engine_crashed')}</span>
      <button
        type="button"
        className={styles.restart}
        onClick={handleClick}
        disabled={restarting}
        data-testid="degraded-banner-restart"
      >
        {t('degraded.restart')}
      </button>
    </div>
  );
}

DegradedBanner.displayName = 'DegradedBanner';
