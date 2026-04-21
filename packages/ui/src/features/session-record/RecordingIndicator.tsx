/**
 * RecordingIndicator — the small "● REC mm:ss" chip in the status bar.
 *
 * Renders nothing when there is no active recording. Ticks once per second
 * via a self-owned effect so we don't force the status bar to re-render on
 * every byte captured. Reduced-motion-aware: the pulse animation is disabled
 * via `prefers-reduced-motion` in the CSS module.
 */

import { useEffect, useState } from 'react';

import { useSessionRecordStore } from '../../entities/session-record/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './recording-indicator.module.css';

function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function RecordingIndicator() {
  const recording = useSessionRecordStore((s) => s.recording);
  const startedAtMs = useSessionRecordStore((s) => s.startedAtMs);
  // Local wall-clock tick so the mm:ss chip updates once per second even when
  // no bytes are arriving (idle shell). The controller also ticks the store
  // from its interval; we key off our own here so the render cadence is
  // decoupled from bulk-byte-arrival churn.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [recording]);

  if (!recording || startedAtMs === 0) return null;

  const elapsedSec = Math.max(0, (now - startedAtMs) / 1000);
  const display = formatDuration(elapsedSec);

  return (
    <span
      className={styles.indicator}
      role="status"
      aria-live="polite"
      aria-label={t('sessionRecord.indicator.aria', { time: display })}
      data-testid="recording-indicator"
    >
      <span className={styles.dot} aria-hidden />
      <span className={styles.label}>{t('sessionRecord.indicator.label')}</span>
      <span className={styles.timer} data-testid="recording-indicator-timer">
        {display}
      </span>
    </span>
  );
}

RecordingIndicator.displayName = 'RecordingIndicator';
