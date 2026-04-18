/**
 * EmptyState — hero shown when no session is active. Two CTAs mirror the
 * top-level keybindings (`Cmd+T` to start a shell, `Cmd+K` for the palette).
 * The component is purely presentational; the page wires the clicks to the
 * same handlers the keymap calls.
 */

import { Button } from '../../shared/ui/button/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import styles from './empty-state.module.css';

export interface EmptyStateProps {
  readonly onNewSession?: () => void;
  readonly onOpenPalette?: () => void;
}

export function EmptyState(props: EmptyStateProps) {
  const { onNewSession, onOpenPalette } = props;
  return (
    <div className={styles.wrap} role="region" aria-label="No active session">
      <div className={styles.hero}>
        <div className={styles.title}>Quanta</div>
        <div className={styles.subtitle}>
          A terminal that knows what your shell is doing.
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={onNewSession}>
            New session <Kbd>⌘</Kbd>
            <Kbd>T</Kbd>
          </Button>
          <Button onClick={onOpenPalette}>
            Command palette <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

EmptyState.displayName = 'EmptyState';
