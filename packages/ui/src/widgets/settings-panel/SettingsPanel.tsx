/**
 * SettingsPanel — modal that groups the app's user-facing preferences.
 *
 * Sections ship:
 *   - Appearance (theme: light / dark / system)
 *   - Keyboard (read-only list of core shortcuts — remapping is a later phase)
 *   - Shell Integration (status chip + install shortcut)
 *   - Privacy (static "telemetry off" disclosure)
 *
 * Opened/closed by the parent (TerminalPage binds `mod+,`). Escape closes.
 * Focus returns to the previously active element on unmount, mirroring the
 * command palette / history search pattern.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Badge } from '../../shared/ui/badge/index.js';
import { Button } from '../../shared/ui/button/index.js';
import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { formatShortcutHint } from '../../shared/lib/keymap.js';
import { t } from '../../shared/i18n/index.js';
import { cx } from '../../shared/lib/cx.js';
import {
  useThemeStore,
  type ThemePreference,
} from '../../features/theme/index.js';
import { useSessionStore } from '../../entities/session/index.js';
import {
  useNotifySettings,
  ensureNotificationPermission,
  MIN_LONG_RUN_THRESHOLD_MS,
  MAX_LONG_RUN_THRESHOLD_MS,
} from '../../features/notifications/index.js';
import type { ShellIntegrationStatus } from '@quanta/host-common';

import styles from './settings-panel.module.css';

export interface SettingsPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Optional — a button "Install shell integration" fires this. */
  readonly onInstallShellIntegration?: () => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { open, onClose, onInstallShellIntegration } = props;
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const shellIntegration = useSessionStore((s) => s.shellIntegration);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const el = panelRef.current;
    if (!el) return;
    el.focus();
    const trap = activateFocusTrap(el);
    return () => {
      trap.deactivate();
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') target.focus();
      previouslyFocused.current = null;
    };
  }, [open]);

  const handleBackdropMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  const shortcuts = useMemo<ReadonlyArray<{ key: Parameters<typeof t>[0]; shortcut: string }>>(
    () => [
      { key: 'settings.keyboard.palette', shortcut: 'mod+k' },
      { key: 'settings.keyboard.history', shortcut: 'mod+f' },
      { key: 'settings.keyboard.newSession', shortcut: 'mod+t' },
      { key: 'settings.keyboard.closeSession', shortcut: 'mod+w' },
      { key: 'settings.keyboard.settings', shortcut: 'mod+,' },
    ],
    [],
  );

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
      data-testid="settings-panel-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.dialogLabel')}
        className={styles.panel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-testid="settings-panel"
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{t('settings.dialogLabel')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            className={styles.closeButton}
            data-testid="settings-panel-close"
          >
            Esc
          </button>
        </header>

        <div className={styles.body}>
          <AppearanceSection theme={theme} onSelect={setTheme} />
          <KeyboardSection shortcuts={shortcuts} />
          <ShellIntegrationSection
            status={shellIntegration}
            {...(onInstallShellIntegration ? { onInstall: onInstallShellIntegration } : {})}
          />
          <NotificationsSection />
          <PrivacySection />
        </div>
      </div>
    </div>
  );
}

SettingsPanel.displayName = 'SettingsPanel';

interface AppearanceProps {
  readonly theme: ThemePreference;
  readonly onSelect: (next: ThemePreference) => void;
}

function AppearanceSection({ theme, onSelect }: AppearanceProps) {
  const THEMES: ReadonlyArray<{ value: ThemePreference; labelKey: Parameters<typeof t>[0] }> = [
    { value: 'light', labelKey: 'settings.theme.light' },
    { value: 'dark', labelKey: 'settings.theme.dark' },
    { value: 'system', labelKey: 'settings.theme.system' },
  ];
  return (
    <section className={styles.section} aria-labelledby="qt-settings-appearance">
      <h3 id="qt-settings-appearance" className={styles.sectionTitle}>
        {t('settings.sections.appearance')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.theme.description')}</p>
      <div className={styles.themeRow} role="radiogroup" aria-label={t('settings.theme.label')}>
        {THEMES.map((opt) => {
          const active = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={cx(styles.themeButton, active && styles.themeButtonActive)}
              data-testid={`settings-theme-${opt.value}`}
              onClick={() => onSelect(opt.value)}
            >
              {t(opt.labelKey)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface KeyboardSectionProps {
  readonly shortcuts: ReadonlyArray<{ key: Parameters<typeof t>[0]; shortcut: string }>;
}

function KeyboardSection({ shortcuts }: KeyboardSectionProps) {
  return (
    <section className={styles.section} aria-labelledby="qt-settings-keyboard">
      <h3 id="qt-settings-keyboard" className={styles.sectionTitle}>
        {t('settings.sections.keyboard')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.keyboard.description')}</p>
      <div className={styles.shortcutList}>
        {shortcuts.map((row) => (
          <div key={row.shortcut} style={{ display: 'contents' }}>
            <span className={styles.shortcutLabel}>{t(row.key)}</span>
            <span className={styles.shortcutHint} data-testid={`settings-shortcut-${row.shortcut}`}>
              {formatShortcutHint(row.shortcut)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ShellIntegrationSectionProps {
  readonly status: ShellIntegrationStatus;
  readonly onInstall?: () => void;
}

function ShellIntegrationSection({ status, onInstall }: ShellIntegrationSectionProps) {
  const tone = status === 'installed' ? 'accent' : status === 'partial' ? 'warning' : 'neutral';
  const labelKey: Parameters<typeof t>[0] =
    status === 'installed'
      ? 'settings.shellIntegration.status.installed'
      : status === 'partial'
        ? 'settings.shellIntegration.status.partial'
        : 'settings.shellIntegration.status.missing';
  return (
    <section className={styles.section} aria-labelledby="qt-settings-shell">
      <h3 id="qt-settings-shell" className={styles.sectionTitle}>
        {t('settings.sections.shellIntegration')}
      </h3>
      <p className={styles.sectionDescription}>
        {t('settings.shellIntegration.description')}
      </p>
      <div className={styles.statusRow}>
        <Badge label={t(labelKey)} tone={tone} />
        {status !== 'installed' && onInstall ? (
          <Button
            type="button"
            variant="primary"
            onClick={onInstall}
            data-testid="settings-install-si"
          >
            {t('settings.shellIntegration.install')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function NotificationsSection() {
  const enabled = useNotifySettings((s) => s.enabled);
  const threshold = useNotifySettings((s) => s.longRunThresholdMs);
  const setEnabled = useNotifySettings((s) => s.setEnabled);
  const setThreshold = useNotifySettings((s) => s.setThresholdMs);
  const seconds = Math.round(threshold / 1000);
  return (
    <section className={styles.section} aria-labelledby="qt-settings-notify">
      <h3 id="qt-settings-notify" className={styles.sectionTitle}>
        {t('settings.sections.notifications')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.notifications.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              const next = e.target.checked;
              setEnabled(next);
              // Prompt for OS notification permission only when the user
              // actively enables the setting — this onChange fires inside a
              // user gesture, so the browser will accept the request. We
              // ignore the resolved value: if the user denies, the detector
              // will simply short-circuit in notify().
              if (next) {
                void ensureNotificationPermission({ allowPrompt: true });
              }
            }}
            data-testid="settings-notify-toggle"
          />{' '}
          {t('settings.notifications.toggleLabel')}
        </label>
      </div>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          {t('settings.notifications.thresholdLabel')}
          <input
            type="range"
            min={Math.round(MIN_LONG_RUN_THRESHOLD_MS / 1000)}
            max={Math.round(MAX_LONG_RUN_THRESHOLD_MS / 1000)}
            step={1}
            value={seconds}
            onChange={(e) => setThreshold(Number(e.target.value) * 1000)}
            disabled={!enabled}
            data-testid="settings-notify-threshold"
          />{' '}
          <span data-testid="settings-notify-threshold-value">{seconds}s</span>
        </label>
      </div>
    </section>
  );
}

function PrivacySection() {
  return (
    <section className={styles.section} aria-labelledby="qt-settings-privacy">
      <h3 id="qt-settings-privacy" className={styles.sectionTitle}>
        {t('settings.sections.privacy')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.privacy.description')}</p>
      <p className={styles.privacyNote}>{t('settings.privacy.telemetryOff')}</p>
    </section>
  );
}
