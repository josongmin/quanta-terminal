/**
 * TitleBar — frameless macOS-first window chrome.
 *
 * Layout (left → right):
 *   [traffic-light cutout]  [Quanta · dir]  …drag…  [session chip]  [⌘K hint]
 *
 * The traffic-light cutout on the left is a non-drag region so the native
 * macOS buttons receive clicks; the rest of the bar is draggable. The right
 * side hosts the palette hint — clicking it opens the palette by firing a
 * keydown the app listens for (keeps the title bar ignorant of the palette's
 * open state).
 */

import type { ReactNode } from 'react';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { useSessionStore } from '../../entities/session/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './title-bar.module.css';

export interface TitleBarProps {
  /** Click handler for the palette hint. */
  readonly onOpenPalette?: () => void;
  /**
   * Content slot rendered on the right, just before the palette hint. The
   * page injects `<SessionTabs />` here — the title bar stays ignorant of
   * other widget slices, which keeps the FSD layer rule intact.
   */
  readonly rightSlot?: ReactNode;
}

export function TitleBar(props: TitleBarProps) {
  const { onOpenPalette, rightSlot } = props;
  const shell = useSessionStore((s) => s.shell);
  const cwd = useSessionStore((s) => s.cwd);
  return (
    <header
      className={styles.bar}
      data-tauri-drag-region="true"
      role="banner"
      aria-label={t('titleBar.region')}
    >
      <div className={styles.trafficCutout} data-tauri-drag-region="false" aria-hidden />
      <div className={styles.left} data-tauri-drag-region="true">
        <strong className={styles.brand}>Quanta</strong>
        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span className={styles.subtle}>{shell ? shortenCwd(cwd) : t('titleBar.booting')}</span>
      </div>
      <div className={styles.center} data-tauri-drag-region="true" aria-hidden />
      <div className={styles.right} data-tauri-drag-region="false">
        {rightSlot}
        <button
          type="button"
          className={styles.paletteHint}
          onClick={onOpenPalette}
          aria-label={t('titleBar.openPalette')}
          title={t('titleBar.openPalette')}
        >
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>
    </header>
  );
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '~';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/u.exec(cwd);
  if (m) return '~' + (m[2] ?? '');
  return cwd;
}

TitleBar.displayName = 'TitleBar';
