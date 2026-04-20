/**
 * TitleBar — app toolbar rendered directly below the OS-native window chrome.
 *
 * Layout (left → right):
 *   [Quanta · dir]  …flex spacer…  [session chip]  [⌘K hint]
 *
 * History: prior versions used a frameless-window design where this bar
 * doubled as the window drag handle (`data-tauri-drag-region="true"`) with a
 * 72 px cutout on the left for macOS traffic lights. That approach has been
 * retired in favour of native OS decorations — `tauri.conf.json` now sets
 * `decorations: true` and `titleBarStyle: "Visible"`, so the OS draws the
 * real title bar above this widget. Window drag, double-click-to-maximize,
 * the system context menu, and traffic-light buttons are all handled by the
 * window manager. This component is now a plain semantic `<header>` with no
 * drag-region attributes or cutouts.
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
    <header className={styles.bar} role="banner" aria-label={t('titleBar.region')}>
      <div className={styles.left}>
        <strong className={styles.brand}>Quanta</strong>
        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span className={styles.subtle}>{shell ? shortenCwd(cwd) : t('titleBar.booting')}</span>
      </div>
      <div className={styles.center} aria-hidden />
      <div className={styles.right}>
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
