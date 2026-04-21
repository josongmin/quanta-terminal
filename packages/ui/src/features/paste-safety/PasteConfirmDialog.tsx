/**
 * PasteConfirmDialog — modal asking the user to confirm a risky paste.
 *
 * Used by both the composer widget and the TUI input surface. The component
 * is fully controlled: caller passes the analysis + text + handlers, we only
 * manage focus-trap / Escape handling.
 *
 * Keyboard:
 *   - Escape cancels (closes dialog, rejects the paste).
 *   - Enter confirms (pastes anyway). For `danger` pastes the cancel button
 *     is default-focused so a reflex Enter does NOT auto-execute the paste.
 */

import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { Badge } from '../../shared/ui/badge/index.js';
import { Button } from '../../shared/ui/button/index.js';
import { t } from '../../shared/i18n/index.js';
import { cx } from '../../shared/lib/cx.js';
import type { PasteAnalysis } from './analyze.js';
import styles from './paste-confirm-dialog.module.css';

/** Hard cap on preview bytes shown in the dialog. The real payload may be
 *  much larger — we truncate to keep the modal rendering quick. */
const PREVIEW_CAP = 2_000;

export interface PasteConfirmDialogProps {
  /** The paste text awaiting user approval. `null` closes the dialog. */
  readonly text: string | null;
  /** The analysis result that triggered the dialog. */
  readonly analysis: PasteAnalysis | null;
  /** User clicked Cancel or pressed Escape. */
  readonly onCancel: () => void;
  /** User clicked Paste Anyway or pressed Enter. */
  readonly onConfirm: () => void;
}

export function PasteConfirmDialog(props: PasteConfirmDialogProps) {
  const { text, analysis, onCancel, onConfirm } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!analysis || text === null) return;
    const container = containerRef.current;
    if (!container) return;
    const trap = activateFocusTrap(container);
    // Default focus: Cancel for danger (so a reflex Enter does not execute a
    // destructive paste), Paste-Anyway for warn.
    if (analysis.level === 'danger') {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
    return () => trap.deactivate();
  }, [analysis, text]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  if (analysis === null || text === null) return null;

  const truncated = text.length > PREVIEW_CAP;
  const preview = truncated ? text.slice(0, PREVIEW_CAP) : text;
  const danger = analysis.level === 'danger';
  const titleKey = danger ? 'pasteSafety.title.danger' : 'pasteSafety.title.warn';

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-testid="paste-confirm-backdrop"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-confirm-title"
        aria-describedby="paste-confirm-reasons"
        className={cx(styles.panel, danger && styles.panelDanger)}
        onKeyDown={handleKeyDown}
        data-testid="paste-confirm-dialog"
      >
        <div className={styles.header}>
          <Badge
            label={t(
              danger ? 'pasteSafety.badgeDanger' : 'pasteSafety.badgeWarn',
            )}
            tone={danger ? 'danger' : 'warning'}
          />
          <h2 id="paste-confirm-title" className={styles.title}>
            {t(titleKey)}
          </h2>
        </div>
        <ul
          id="paste-confirm-reasons"
          className={styles.reasons}
          aria-label={t('pasteSafety.reasonsLabel')}
        >
          {analysis.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className={styles.previewLabel}>{t('pasteSafety.previewLabel')}</div>
        <pre className={styles.preview} data-testid="paste-confirm-preview">
          {preview}
        </pre>
        {truncated ? (
          <div className={styles.truncated}>
            {t('pasteSafety.truncated', {
              chars: text.length.toLocaleString(),
            })}
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button
            ref={cancelRef}
            onClick={onCancel}
            data-testid="paste-confirm-cancel"
          >
            {t('pasteSafety.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            onClick={onConfirm}
            data-testid="paste-confirm-accept"
          >
            {t('pasteSafety.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

PasteConfirmDialog.displayName = 'PasteConfirmDialog';
