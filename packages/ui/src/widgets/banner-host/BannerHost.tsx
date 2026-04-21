/**
 * BannerHost — one-at-a-time banner area under the title bar.
 *
 * Reads the banner entity slice, applies the ADR-0010 precedence rule
 * (`shared/lib/banner-precedence`), and renders at most one `<Banner>`.
 *
 * The host decides:
 *   - which copy/kind/action/dismiss verb belongs to each condition;
 *   - whether the condition is announced politely (role="status") or as an
 *     alert (role="alert"). Crash is the one alert case — it demands
 *     immediate screen-reader attention.
 *
 * The host does not decide what conditions are "active"; the banner store
 * + `features/banner/detect` own that upstream. Tests push synthetic
 * conditions via `raiseSyntheticBanner` to exercise precedence rendering.
 */

import { useCallback, useMemo } from 'react';

import { Banner } from '../../shared/ui/banner/index.js';
import { Button } from '../../shared/ui/button/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { pickBannerCondition, type BannerCondition } from '../../shared/lib/banner-precedence.js';
import type { BannerKind } from '../../shared/ui/banner/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './banner-host.module.css';

/**
 * The action button handler is a Phase-1 stub — it must exist so the Button
 * renders an interactive surface, but the real target (settings pane / docs
 * link) is plumbed in later phases. Lifting it to module scope keeps the
 * reference stable so `Button`'s internals don't churn on every host render
 * while the placeholder is in place.
 */
const NOOP_ACTION = (): void => {
  /* Phase 1 stub; later phases route to the condition-specific destination. */
};

interface ConditionPresentation {
  readonly kind: BannerKind;
  readonly message: string;
  readonly actionLabel: string;
  readonly dismissLabel: string;
  /**
   * `alert` for crash (requires immediate attention), `status` for the rest
   * (polite live region).
   */
  readonly role: 'status' | 'alert';
}

const PRESENTATION: Readonly<Record<BannerCondition, ConditionPresentation>> = {
  crash: {
    kind: 'danger',
    message: t('banner.crash.message'),
    actionLabel: t('banner.crash.action'),
    dismissLabel: t('banner.dismissDefault'),
    role: 'alert',
  },
  quota: {
    kind: 'warning',
    message: t('banner.quota.message'),
    actionLabel: t('banner.quota.action'),
    dismissLabel: t('banner.dismissDefault'),
    role: 'status',
  },
  secret_rescan: {
    kind: 'info',
    message: t('banner.secretRescan.message'),
    actionLabel: t('banner.secretRescan.action'),
    dismissLabel: t('banner.dismissDefault'),
    role: 'status',
  },
  shell_integration: {
    kind: 'info',
    message: t('banner.shellIntegration.message'),
    actionLabel: t('banner.shellIntegration.action'),
    dismissLabel: t('banner.shellIntegration.dismiss'),
    role: 'status',
  },
};

export function BannerHost() {
  const active = useBannerStore((s) => s.active);
  const dismissed = useBannerStore((s) => s.dismissed);
  const dismiss = useBannerStore((s) => s.dismiss);

  // Derived list is memoized against the raw sets so selectors do not create
  // a new array on unrelated store updates.
  const visible = useMemo(
    () => selectVisibleConditions({ active, dismissed }),
    [active, dismissed],
  );
  const top = useMemo(() => {
    const filtered = visible.filter((c) => c !== 'shell_integration');
    return pickBannerCondition(filtered);
  }, [visible]);

  // Wrap the store-backed dismiss in a useCallback keyed on `top` so the
  // `onDismiss` prop is referentially stable for each presented banner. Without
  // this wrap the Banner primitive re-renders on every parent tick because the
  // inline arrow function mints a fresh identity each time.
  const handleDismiss = useCallback(() => {
    if (top) dismiss(top);
  }, [dismiss, top]);

  if (!top) return null;

  const p = PRESENTATION[top];
  return (
    <div className={styles.host} data-testid="banner-host">
      <div
        className={styles.slide}
        // Override the primitive's aria-live when we need alert-level urgency.
        role={p.role}
        aria-live={p.role === 'alert' ? 'assertive' : 'polite'}
      >
        <Banner
          kind={p.kind}
          onDismiss={handleDismiss}
          dismissLabel={p.dismissLabel}
          action={
            <Button type="button" onClick={NOOP_ACTION}>
              {p.actionLabel}
            </Button>
          }
        >
          {p.message}
        </Banner>
      </div>
    </div>
  );
}

BannerHost.displayName = 'BannerHost';
