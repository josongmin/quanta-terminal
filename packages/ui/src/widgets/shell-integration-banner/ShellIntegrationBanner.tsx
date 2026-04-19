/**
 * ShellIntegrationBanner — dismissable banner that offers to open the
 * shell-integration install wizard.
 *
 * Appears iff `session.shellIntegration === 'missing'` AND the user has not
 * dismissed it this session. The generic BannerHost already raises a
 * shell_integration condition; this widget is the dedicated variant with
 * the wired "Install" button that opens the Wizard modal.
 *
 * The widget is self-contained: it owns the Wizard's `open` state. Parents
 * drop `<ShellIntegrationBanner />` in the banner-host stack.
 *
 * Dismiss: per-session via the banner store. Clicking "Not now" flips the
 * dismissed bit; opening the wizard does NOT mutate session state — the
 * banner can reappear after a session reset.
 */

import { useCallback, useMemo, useState } from 'react';
import { Banner } from '../../shared/ui/banner/index.js';
import { Button } from '../../shared/ui/button/index.js';
import { useSessionStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import {
  Wizard,
  detect,
  type DetectionResult,
} from '../../features/shell-integration-wizard/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './shell-integration-banner.module.css';

export interface ShellIntegrationBannerProps {
  /**
   * When provided, overrides the wizard's bridge-facing helpers. Used by
   * tests; production omits this.
   */
  readonly wizardOverrides?: React.ComponentProps<typeof Wizard>['overrides'];
}

export function ShellIntegrationBanner(props: ShellIntegrationBannerProps) {
  const { wizardOverrides } = props;
  const shellIntegration = useSessionStore((s) => s.shellIntegration);
  const rawShell = useSessionStore((s) => s.shell);
  const dismissed = useBannerStore((s) => s.dismissed);
  const dismiss = useBannerStore((s) => s.dismiss);
  const [wizardOpen, setWizardOpen] = useState(false);

  const detection: DetectionResult = useMemo(
    () => detect({ shellIntegration, shell: rawShell }),
    [shellIntegration, rawShell],
  );

  const handleInstall = useCallback(() => {
    setWizardOpen(true);
  }, []);

  const handleDismiss = useCallback(() => {
    dismiss('shell_integration');
  }, [dismiss]);

  const handleClose = useCallback(() => {
    setWizardOpen(false);
  }, []);

  // Hide the banner if the user dismissed it or the integration is fine.
  const visible = detection.needsInstall && !dismissed.has('shell_integration');

  // Build wizard props once; `exactOptionalPropertyTypes` forbids passing
  // `undefined` on optional fields, so we conditionally include `overrides`.
  const wizardProps = {
    open: wizardOpen,
    onClose: handleClose,
    detection,
    ...(wizardOverrides ? { overrides: wizardOverrides } : {}),
  } as const;

  if (!visible) {
    // Still render the wizard if the user opened it before the status flipped
    // — avoids a jarring unmount while the install is in flight. When
    // `wizardOpen` is also false, this path renders nothing.
    if (wizardOpen) {
      return <Wizard {...wizardProps} />;
    }
    return null;
  }

  return (
    <div className={styles.host} data-testid="shell-integration-banner">
      <div className={styles.slide} role="status" aria-live="polite">
        <Banner
          kind="info"
          onDismiss={handleDismiss}
          dismissLabel={t('shellIntegrationBanner.dismiss')}
          action={
            <Button
              type="button"
              variant="primary"
              onClick={handleInstall}
              data-testid="shell-integration-banner-install"
            >
              {t('shellIntegrationBanner.install')}
            </Button>
          }
        >
          {t('shellIntegrationBanner.body', { shell: detection.shell })}
        </Banner>
      </div>
      <Wizard {...wizardProps} />
    </div>
  );
}

ShellIntegrationBanner.displayName = 'ShellIntegrationBanner';
