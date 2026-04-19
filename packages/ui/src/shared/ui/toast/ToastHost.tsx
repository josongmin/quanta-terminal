/**
 * ToastHost — renders the current toast queue in a fixed region.
 *
 * Mount once near the app root (we suggest alongside BannerHost). The host
 * subscribes to `useToastStore` and renders each live toast; auto-dismiss is
 * scheduled inside `showToast` so the host is purely a view.
 *
 * Accessibility: uses `aria-live="polite"` and `role="status"` per the WCAG
 * "notification" pattern so screen readers announce without interrupting.
 */

import { cx } from '../../lib/cx.js';
import { useToastStore } from './toast-store.js';
import styles from './toast.module.css';

export function ToastHost() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismissToast);
  if (items.length === 0) return null;
  return (
    <div className={styles.region} aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(styles.toast, styles[`kind-${t.kind}`])}
          data-toast-kind={t.kind}
        >
          <span className={styles.message}>{t.message}</span>
          <button
            type="button"
            className={styles.dismiss}
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

ToastHost.displayName = 'ToastHost';
