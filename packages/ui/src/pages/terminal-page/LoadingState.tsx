/**
 * LoadingState — inline surface shown while the session is booting. Kept
 * minimal; the composer and status bar render next to it so the user still
 * sees progress from the chrome.
 */

import { Spinner } from '../../shared/ui/spinner/index.js';
import styles from './loading-state.module.css';

export function LoadingState() {
  // The nested <Spinner /> already carries role="status" + aria-label, which
  // is the right SR surface. Duplicating role+label on the wrap creates two
  // overlapping landmarks and screen readers announce the loading state twice.
  return (
    <div className={styles.wrap} data-testid="loading-state">
      <Spinner size="md" label="Starting shell session" />
      <span className={styles.label}>Starting a shell…</span>
    </div>
  );
}

LoadingState.displayName = 'LoadingState';
