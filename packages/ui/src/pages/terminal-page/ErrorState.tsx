/**
 * ErrorState — shown when the session has errored out. Keeps the message
 * concise and offers a single retry affordance. The caller wires the retry.
 */

import { Button } from '../../shared/ui/button/index.js';
import styles from './error-state.module.css';

export interface ErrorStateProps {
  readonly message?: string;
  readonly onRetry?: () => void;
}

export function ErrorState(props: ErrorStateProps) {
  const { message = 'Your shell failed to start.', onRetry } = props;
  return (
    <div className={styles.wrap} role="alert">
      <div className={styles.icon} aria-hidden>
        !
      </div>
      <div className={styles.message}>{message}</div>
      {onRetry ? (
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

ErrorState.displayName = 'ErrorState';
