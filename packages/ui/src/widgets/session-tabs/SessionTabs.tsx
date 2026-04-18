/**
 * SessionTabs — placeholder for Phase 2 multi-session support.
 *
 * Today the session store holds a single `id`. When multi-session lands,
 * this widget becomes the row of session chips; until then it renders a
 * single disabled chip labelled with the current shell so the chrome is
 * structurally whole. Keeping the widget shipped (but thin) means the
 * layout does not shift when the real tabs arrive.
 */

import { useSessionStore } from '../../entities/session/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './session-tabs.module.css';

export function SessionTabs() {
  const shell = useSessionStore((s) => s.shell);
  const id = useSessionStore((s) => s.id);
  const health = useSessionStore((s) => s.health);

  const label = shellDisplay(shell) ?? 'session';
  return (
    <div className={styles.row} role="tablist" aria-label="Sessions">
      <button
        type="button"
        role="tab"
        aria-selected="true"
        aria-label={`Active session ${label}`}
        className={cx(styles.tab, styles.active)}
        disabled={!id}
      >
        <span
          className={cx(styles.pulse, health === 'ready' && styles.pulseOn)}
          aria-hidden
        />
        <span className={styles.label}>{label}</span>
      </button>
    </div>
  );
}

function shellDisplay(path: string): string | undefined {
  if (!path) return undefined;
  const base = path.split('/').filter(Boolean).pop();
  return base ?? path;
}

SessionTabs.displayName = 'SessionTabs';
