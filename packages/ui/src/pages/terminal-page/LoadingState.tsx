/**
 * LoadingState — inline surface shown while the session is booting. Kept
 * minimal; the composer and status bar render next to it so the user still
 * sees progress from the chrome.
 */

import { Spinner } from '../../shared/ui/spinner/index.js';
import styles from './loading-state.module.css';

export function LoadingState() {
  return (
    <div className={styles.wrap} role="status" aria-label="Starting shell session">
      <Spinner size="md" label="Starting shell session" />
      <span className={styles.label}>Starting a shell…</span>
    </div>
  );
}

LoadingState.displayName = 'LoadingState';
