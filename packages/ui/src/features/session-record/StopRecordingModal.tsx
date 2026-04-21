/**
 * StopRecordingModal — post-stop "what do you want to do with this capture?"
 * dialog. Reused pattern from `paste-safety/PasteConfirmDialog` — same
 * backdrop + focus-trap idiom.
 *
 * Actions:
 *   - Copy to clipboard (navigator.clipboard.writeText)
 *   - Download .cast (Blob URL + <a download>)
 *   - Discard (just close)
 *
 * The component is fully controlled; the terminal page renders it based on a
 * pending `StopRecordingResult` pushed through `subscribeStopResult`.
 */

import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { Button } from '../../shared/ui/button/index.js';
import { showToast } from '../../shared/ui/toast/index.js';
import { t } from '../../shared/i18n/index.js';
import { suggestCastFilename } from './recorder.js';
import type { StopRecordingResult } from './controller.js';
import styles from './stop-recording-modal.module.css';

export interface StopRecordingModalProps {
  /** Non-null when the modal should be shown. */
  readonly result: StopRecordingResult | null;
  readonly onDismiss: () => void;
}

function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function StopRecordingModal(props: StopRecordingModalProps) {
  const { result, onDismiss } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const downloadRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (result === null) return;
    const container = containerRef.current;
    if (!container) return;
    const trap = activateFocusTrap(container);
    downloadRef.current?.focus();
    return () => trap.deactivate();
  }, [result]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    },
    [onDismiss],
  );

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.jsonl);
        showToast({ kind: 'info', message: t('sessionRecord.modal.copyOk') });
      } else {
        showToast({ kind: 'warning', message: t('sessionRecord.modal.copyUnavailable') });
      }
    } catch {
      showToast({ kind: 'warning', message: t('sessionRecord.modal.copyFail') });
    }
  }, [result]);

  const handleDownload = useCallback(() => {
    if (!result) return;
    try {
      const blob = new Blob([result.jsonl], { type: 'application/x-asciicast' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestCastFilename();
      a.rel = 'noopener';
      // Must be in the DOM for some older browsers to honour the download
      // attribute; we add + remove synchronously so it never shows up.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Delay the revoke so Safari can still read the Blob URL at click time.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      showToast({ kind: 'info', message: t('sessionRecord.modal.downloadOk') });
      onDismiss();
    } catch {
      showToast({ kind: 'warning', message: t('sessionRecord.modal.downloadFail') });
    }
  }, [result, onDismiss]);

  if (result === null) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-testid="stop-recording-backdrop"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stop-recording-title"
        className={styles.panel}
        onKeyDown={handleKeyDown}
        data-testid="stop-recording-dialog"
      >
        <div className={styles.header}>
          <h2 id="stop-recording-title" className={styles.title}>
            {t('sessionRecord.modal.title')}
          </h2>
        </div>
        <dl className={styles.stats} aria-label={t('sessionRecord.modal.statsLabel')}>
          <div className={styles.statRow}>
            <dt>{t('sessionRecord.modal.statDuration')}</dt>
            <dd data-testid="stop-recording-duration">{formatDuration(result.durationSec)}</dd>
          </div>
          <div className={styles.statRow}>
            <dt>{t('sessionRecord.modal.statBytes')}</dt>
            <dd data-testid="stop-recording-bytes">{formatBytes(result.byteCount)}</dd>
          </div>
          <div className={styles.statRow}>
            <dt>{t('sessionRecord.modal.statEvents')}</dt>
            <dd data-testid="stop-recording-events">{result.eventCount}</dd>
          </div>
        </dl>
        <div className={styles.actions}>
          <Button onClick={onDismiss} data-testid="stop-recording-discard">
            {t('sessionRecord.modal.discard')}
          </Button>
          <Button onClick={handleCopy} data-testid="stop-recording-copy">
            {t('sessionRecord.modal.copy')}
          </Button>
          <Button
            ref={downloadRef}
            variant="primary"
            onClick={handleDownload}
            data-testid="stop-recording-download"
          >
            {t('sessionRecord.modal.download')}
          </Button>
        </div>
      </div>
    </div>
  );
}

StopRecordingModal.displayName = 'StopRecordingModal';
