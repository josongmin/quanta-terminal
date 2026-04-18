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

import { useMemo } from 'react';

import { Banner } from '../../shared/ui/banner/index.js';
import { Button } from '../../shared/ui/button/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { pickBannerCondition, type BannerCondition } from '../../shared/lib/banner-precedence.js';
import type { BannerKind } from '../../shared/ui/banner/index.js';
import styles from './banner-host.module.css';

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
    message: 'Your shell exited unexpectedly. Session has been recovered.',
    actionLabel: 'View crash details',
    dismissLabel: 'Dismiss',
    role: 'alert',
  },
  quota: {
    kind: 'warning',
    message: 'History storage is above the soft quota. Older blocks may be pruned.',
    actionLabel: 'Open history settings',
    dismissLabel: 'Dismiss',
    role: 'status',
  },
  secret_rescan: {
    kind: 'info',
    message: 'Secret redaction rules changed. Rescanning recent history.',
    actionLabel: 'Review rules',
    dismissLabel: 'Dismiss',
    role: 'status',
  },
  shell_integration: {
    kind: 'info',
    message: 'Shell integration is not installed — cwd and prompts are estimated.',
    actionLabel: 'Install shell integration',
    dismissLabel: 'Not now',
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
  const top = useMemo(() => pickBannerCondition(visible), [visible]);

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
          onDismiss={() => dismiss(top)}
          dismissLabel={p.dismissLabel}
          action={
            <Button
              type="button"
              onClick={() => {
                // Phase 1: the action is a stub. Later phases swap the handler
                // for one that opens the relevant settings pane.
              }}
            >
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
