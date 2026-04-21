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
  useState,
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
  useSessionProfiles,
  SHELL_PATHS,
  kindForShellPath,
  isValidEnvKey,
  MAX_STARTUP_ENV_ENTRIES,
  type SessionProfile,
  type SessionProfileShellKind,
} from '../../entities/session-profile/index.js';
import {
  useNotifySettings,
  ensureNotificationPermission,
  MIN_LONG_RUN_THRESHOLD_MS,
  MAX_LONG_RUN_THRESHOLD_MS,
} from '../../features/notifications/index.js';
import { useSecretRedactSettings } from '../../features/secret-detect/index.js';
import { useAiExplainSettings } from '../../features/ai-explain/index.js';
import { useBellSettings } from '../../features/bell/index.js';
import {
  useA11yAnnounceSettings,
  type A11yAnnounceMode,
} from '../../features/a11y-announce/index.js';
import { KeybindingsSection } from '../../features/keybindings/index.js';
import {
  useFontSettings,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from '../../features/font-settings/index.js';
import {
  useImportedHistoryStore,
  runImportForce,
} from '../../features/shell-history-import/index.js';
import {
  useWorkspaceSnapshotStore,
  saveNamedSnapshot,
  splitSnapshots,
  type WorkspaceSnapshot,
} from '../../features/workspace-snapshot/index.js';
import { restoreSnapshot as restoreWorkspaceSnapshot } from '../../features/workspace-snapshot/serialize.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
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
      { key: 'settings.keyboard.outputSearch', shortcut: 'mod+f' },
      { key: 'settings.keyboard.history', shortcut: 'mod+shift+f' },
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
          <FontSection />
          <KeyboardSection shortcuts={shortcuts} />
          <KeybindingsSection />
          <ShellIntegrationSection
            status={shellIntegration}
            {...(onInstallShellIntegration ? { onInstall: onInstallShellIntegration } : {})}
          />
          <NotificationsSection />
          <SessionProfilesSection />
          <SecretsSection />
          <AiExplainSection />
          <BellSection />
          <A11yAnnounceSection />
          <ShellHistoryImportSection />
          <WorkspaceSnapshotsSection />
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

function BellSection() {
  const visualBell = useBellSettings((s) => s.visualBell);
  const audibleBell = useBellSettings((s) => s.audibleBell);
  const setVisualBell = useBellSettings((s) => s.setVisualBell);
  const setAudibleBell = useBellSettings((s) => s.setAudibleBell);
  return (
    <section className={styles.section} aria-labelledby="qt-settings-bell">
      <h3 id="qt-settings-bell" className={styles.sectionTitle}>
        {t('settings.sections.bell')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.bell.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={visualBell}
            onChange={(e) => setVisualBell(e.target.checked)}
            data-testid="settings-bell-visual-toggle"
          />{' '}
          {t('settings.bell.visualLabel')}
        </label>
      </div>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={audibleBell}
            onChange={(e) => setAudibleBell(e.target.checked)}
            data-testid="settings-bell-audible-toggle"
          />{' '}
          {t('settings.bell.audibleLabel')}
        </label>
      </div>
    </section>
  );
}

function A11yAnnounceSection() {
  const enabled = useA11yAnnounceSettings((s) => s.enabled);
  const mode = useA11yAnnounceSettings((s) => s.mode);
  const setEnabled = useA11yAnnounceSettings((s) => s.setEnabled);
  const setMode = useA11yAnnounceSettings((s) => s.setMode);
  const effective: A11yAnnounceMode = enabled && mode !== 'off' ? mode : 'polite';
  const shortcutHint = formatShortcutHint('mod+alt+a');
  return (
    <section className={styles.section} aria-labelledby="qt-settings-a11y-announce">
      <h3 id="qt-settings-a11y-announce" className={styles.sectionTitle}>
        {t('settings.sections.a11yAnnounce')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.a11yAnnounce.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="settings-a11y-announce-toggle"
          />{' '}
          {t('settings.a11yAnnounce.toggleLabel')}
        </label>
      </div>
      <div
        className={styles.statusRow}
        role="radiogroup"
        aria-label={t('settings.a11yAnnounce.modeLabel')}
      >
        <label className={styles.shortcutLabel}>
          <input
            type="radio"
            name="qt-a11y-announce-mode"
            value="polite"
            checked={effective === 'polite'}
            disabled={!enabled}
            onChange={() => setMode('polite')}
            data-testid="settings-a11y-announce-polite"
          />{' '}
          {t('settings.a11yAnnounce.mode.polite')}
        </label>
        <label className={styles.shortcutLabel}>
          <input
            type="radio"
            name="qt-a11y-announce-mode"
            value="assertive"
            checked={effective === 'assertive'}
            disabled={!enabled}
            onChange={() => setMode('assertive')}
            data-testid="settings-a11y-announce-assertive"
          />{' '}
          {t('settings.a11yAnnounce.mode.assertive')}
        </label>
      </div>
      <p className={styles.sectionDescription} data-testid="settings-a11y-announce-hint">
        {t('settings.a11yAnnounce.shortcutHint', { shortcut: shortcutHint })}
      </p>
    </section>
  );
}

function ShellHistoryImportSection() {
  const entries = useImportedHistoryStore((s) => s.entries);
  const source = useImportedHistoryStore((s) => s.source);
  const importedAt = useImportedHistoryStore((s) => s.importedAt);
  const clear = useImportedHistoryStore((s) => s.clear);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const status = useMemo(() => {
    if (entries.length > 0 && source !== null) {
      return t('settings.shellHistoryImport.status.imported', {
        count: formatCount(entries.length),
        source,
      });
    }
    return t('settings.shellHistoryImport.status.empty');
  }, [entries.length, source]);

  const timestampLabel = useMemo(() => {
    if (importedAt === null) return '';
    try {
      const d = new Date(importedAt);
      return d.toLocaleString();
    } catch {
      return '';
    }
  }, [importedAt]);

  const handleReimport = useCallback(async () => {
    const bridge = tryGetHostBridge();
    if (!bridge) {
      setLastError(t('settings.shellHistoryImport.error.noBridge'));
      return;
    }
    setBusy(true);
    setLastError(null);
    try {
      const result = await runImportForce({ bridge });
      if (!result.imported) {
        setLastError(
          t('settings.shellHistoryImport.error.skipReason', {
            reason: result.skipReason ?? 'unknown',
          }),
        );
      }
    } catch (err) {
      setLastError(
        err instanceof Error ? err.message : String(err ?? 'unknown error'),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const handleClear = useCallback(() => {
    clear();
    setLastError(null);
  }, [clear]);

  return (
    <section
      className={styles.section}
      aria-labelledby="qt-settings-shell-history-import"
      data-testid="settings-shell-history-import"
    >
      <h3 id="qt-settings-shell-history-import" className={styles.sectionTitle}>
        {t('settings.sections.shellHistoryImport')}
      </h3>
      <p className={styles.sectionDescription}>
        {t('settings.shellHistoryImport.description')}
      </p>
      <div className={styles.statusRow}>
        <span
          className={styles.shortcutLabel}
          data-testid="settings-shell-history-import-status"
        >
          {status}
        </span>
      </div>
      {timestampLabel ? (
        <div className={styles.statusRow}>
          <span className={styles.sectionDescription}>
            {t('settings.shellHistoryImport.lastImport', {
              when: timestampLabel,
            })}
          </span>
        </div>
      ) : null}
      <div className={styles.statusRow}>
        <Button
          type="button"
          variant="primary"
          onClick={handleReimport}
          disabled={busy}
          data-testid="settings-shell-history-import-reimport"
        >
          {busy
            ? t('settings.shellHistoryImport.reimporting')
            : t('settings.shellHistoryImport.reimport')}
        </Button>
        <button
          type="button"
          className={styles.profileMiniButton}
          onClick={handleClear}
          disabled={entries.length === 0 || busy}
          data-testid="settings-shell-history-import-clear"
        >
          {t('settings.shellHistoryImport.clear')}
        </button>
      </div>
      {lastError !== null && (
        <p
          className={styles.privacyNote}
          data-testid="settings-shell-history-import-error"
        >
          {lastError}
        </p>
      )}
    </section>
  );
}

/** Insert thousands separators without pulling in Intl for the common
 *  path. `Intl.NumberFormat` is fine; we just want a deterministic output
 *  across locales for the test snapshot. */
function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function SecretsSection() {
  const enabled = useSecretRedactSettings((s) => s.enabled);
  const setEnabled = useSecretRedactSettings((s) => s.setEnabled);
  return (
    <section className={styles.section} aria-labelledby="qt-settings-secrets">
      <h3 id="qt-settings-secrets" className={styles.sectionTitle}>
        {t('settings.sections.secrets')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.secrets.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="settings-secrets-toggle"
          />{' '}
          {t('settings.secrets.toggleLabel')}
        </label>
      </div>
    </section>
  );
}

function AiExplainSection() {
  const enabled = useAiExplainSettings((s) => s.enabled);
  const setEnabled = useAiExplainSettings((s) => s.setEnabled);
  return (
    <section className={styles.section} aria-labelledby="qt-settings-ai-explain">
      <h3 id="qt-settings-ai-explain" className={styles.sectionTitle}>
        {t('settings.sections.aiExplain')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.aiExplain.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="settings-ai-explain-toggle"
          />{' '}
          {t('settings.aiExplain.toggleLabel')}
        </label>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Session-profiles section
// ----------------------------------------------------------------------------
//
// A list of SessionProfile rows with Edit / Remove / Set-default actions and
// an inline "Add profile" editor. The editor is used for both creation and
// updates — it reads a draft state via useState, validates lightly (non-empty
// name), and dispatches the corresponding store action on Save.
//
// Env is rendered as KEY=VALUE lines in a <textarea>; a round-trip helper
// converts between `Record<string, string>` and that string form. Blank lines
// and lines without `=` are silently dropped. This keeps the editor simple
// (no per-row widget) while still round-tripping cleanly.

/**
 * A single row in the env table. The `id` is a draft-local synthetic key so
 * React can list-key against it even when the user is actively typing the
 * real env var name — if we keyed against `key` directly, renaming a row's
 * first character would remount the <input> and steal focus.
 */
type EnvRow = {
  readonly id: string;
  readonly key: string;
  readonly value: string;
};

type ProfileDraft = {
  readonly name: string;
  readonly shellKind: SessionProfileShellKind;
  readonly shellCustomPath: string;
  readonly cwd: string;
  readonly envRows: readonly EnvRow[];
  readonly startupCommandsText: string;
};

function newEnvRowId(): string {
  return 'row_' + Math.random().toString(36).slice(2, 10);
}

function emptyDraft(): ProfileDraft {
  return {
    name: '',
    shellKind: 'zsh',
    shellCustomPath: '',
    cwd: '',
    envRows: [],
    startupCommandsText: '',
  };
}

function draftFromProfile(p: SessionProfile): ProfileDraft {
  const kind = kindForShellPath(p.shell);
  return {
    name: p.name,
    shellKind: kind,
    shellCustomPath: kind === 'custom' ? p.shell : '',
    cwd: p.cwd ?? '',
    envRows: envToRows(p.env),
    startupCommandsText: (p.startupCommands ?? []).join('\n'),
  };
}

function envToRows(env: Readonly<Record<string, string>> | undefined): EnvRow[] {
  if (!env) return [];
  return Object.entries(env).map(([k, v]) => ({ id: newEnvRowId(), key: k, value: v }));
}

/**
 * Collapse an env-row list to the final `Record<string, string>` we persist.
 * Invalid keys (empty or failing the POSIX regex) are DROPPED silently here —
 * the UI already showed an inline error on blur so the user knows which rows
 * are being ignored; a hard error on Save would block legitimate rows.
 * Duplicate keys: the last-wins.
 */
function envFromRows(rows: readonly EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !isValidEnvKey(key)) continue;
    out[key] = row.value;
  }
  return out;
}

function startupCommandsFromText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    out.push(line);
  }
  return out;
}

/** Resolve the selected kind to a concrete shell path string. */
function draftShellPath(draft: ProfileDraft): string {
  if (draft.shellKind === 'custom') return draft.shellCustomPath.trim();
  if (draft.shellKind === 'zsh') return SHELL_PATHS.zsh;
  if (draft.shellKind === 'bash') return SHELL_PATHS.bash;
  if (draft.shellKind === 'fish') return SHELL_PATHS.fish;
  return '';
}

function SessionProfilesSection() {
  const order = useSessionProfiles((s) => s.order);
  const entities = useSessionProfiles((s) => s.entities);
  const defaultId = useSessionProfiles((s) => s.defaultId);
  const addProfile = useSessionProfiles((s) => s.addProfile);
  const updateProfile = useSessionProfiles((s) => s.updateProfile);
  const removeProfile = useSessionProfiles((s) => s.removeProfile);
  const setDefault = useSessionProfiles((s) => s.setDefault);

  // `editorId` is the id of the profile being edited, or `'new'` when adding.
  // `null` means the editor is closed.
  const [editorId, setEditorId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);

  const startAdd = useCallback(() => {
    setDraft(emptyDraft());
    setEditorId('new');
  }, []);

  const startEdit = useCallback(
    (id: string) => {
      const p = entities[id];
      if (!p) return;
      setDraft(draftFromProfile(p));
      setEditorId(id);
    },
    [entities],
  );

  const cancelEdit = useCallback(() => {
    setEditorId(null);
  }, []);

  const commitEdit = useCallback(() => {
    const name = draft.name.trim();
    if (!name) return; // silent no-op — name is required
    const shell = draftShellPath(draft);
    const cwd = draft.cwd.trim();
    const env = envFromRows(draft.envRows);
    const startupCommands = startupCommandsFromText(draft.startupCommandsText);
    if (editorId === 'new') {
      addProfile({
        name,
        shell,
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(startupCommands.length > 0 ? { startupCommands } : {}),
      });
    } else if (editorId) {
      updateProfile(editorId, {
        name,
        shell,
        cwd,
        env,
        startupCommands,
      });
    }
    setEditorId(null);
  }, [addProfile, draft, editorId, updateProfile]);

  return (
    <section className={styles.section} aria-labelledby="qt-settings-profiles">
      <h3 id="qt-settings-profiles" className={styles.sectionTitle}>
        {t('settings.sections.sessionProfiles')}
      </h3>
      <p className={styles.sectionDescription}>
        {t('settings.sessionProfiles.description')}
      </p>
      <div className={styles.profileList} data-testid="settings-profile-list">
        {order.length === 0 ? (
          <p className={styles.sectionDescription}>
            {t('settings.sessionProfiles.empty')}
          </p>
        ) : null}
        {order.map((id) => {
          const profile = entities[id];
          if (!profile) return null;
          const isDefault = id === defaultId;
          const isEditing = editorId === id;
          if (isEditing) {
            return (
              <ProfileEditor
                key={id}
                draft={draft}
                onDraftChange={setDraft}
                onSave={commitEdit}
                onCancel={cancelEdit}
                testIdSuffix={id}
              />
            );
          }
          return (
            <div
              key={id}
              className={styles.profileRow}
              data-testid={`settings-profile-row-${id}`}
            >
              <div className={styles.profileRowInfo}>
                <div className={styles.profileName}>
                  <span>{profile.name}</span>
                  {isDefault && (
                    <span
                      className={styles.profileDefaultBadge}
                      data-testid={`settings-profile-default-${id}`}
                    >
                      {t('settings.sessionProfiles.defaultBadge')}
                    </span>
                  )}
                </div>
                <div className={styles.profileMeta}>
                  {profile.shell || t('settings.sessionProfiles.shell.hostDefault')}
                  {profile.cwd ? '  ' + profile.cwd : ''}
                </div>
              </div>
              <div className={styles.profileActions}>
                {!isDefault && (
                  <button
                    type="button"
                    className={styles.profileMiniButton}
                    data-testid={`settings-profile-set-default-${id}`}
                    onClick={() => setDefault(id)}
                  >
                    {t('settings.sessionProfiles.setDefault')}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.profileMiniButton}
                  data-testid={`settings-profile-edit-${id}`}
                  onClick={() => startEdit(id)}
                >
                  {t('settings.sessionProfiles.edit')}
                </button>
                <button
                  type="button"
                  className={styles.profileMiniButton}
                  data-testid={`settings-profile-remove-${id}`}
                  onClick={() => removeProfile(id)}
                >
                  {t('settings.sessionProfiles.remove')}
                </button>
              </div>
            </div>
          );
        })}
        {editorId === 'new' && (
          <ProfileEditor
            draft={draft}
            onDraftChange={setDraft}
            onSave={commitEdit}
            onCancel={cancelEdit}
            testIdSuffix="new"
          />
        )}
      </div>
      {editorId === null && (
        <div className={styles.profileEditorActions} style={{ marginTop: 'var(--q-space-3)' }}>
          <Button
            type="button"
            variant="primary"
            onClick={startAdd}
            data-testid="settings-profile-add"
          >
            {t('settings.sessionProfiles.add')}
          </Button>
        </div>
      )}
    </section>
  );
}

interface ProfileEditorProps {
  readonly draft: ProfileDraft;
  readonly onDraftChange: (next: ProfileDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly testIdSuffix: string;
}

function ProfileEditor({
  draft,
  onDraftChange,
  onSave,
  onCancel,
  testIdSuffix,
}: ProfileEditorProps) {
  return (
    <div
      className={styles.profileEditor}
      data-testid={`settings-profile-editor-${testIdSuffix}`}
    >
      <label className={styles.profileField}>
        <span>{t('settings.sessionProfiles.nameLabel')}</span>
        <input
          type="text"
          className={styles.profileInput}
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          data-testid={`settings-profile-name-${testIdSuffix}`}
        />
      </label>
      <label className={styles.profileField}>
        <span>{t('settings.sessionProfiles.shellLabel')}</span>
        <select
          className={styles.profileSelect}
          value={draft.shellKind}
          onChange={(e) =>
            onDraftChange({
              ...draft,
              shellKind: e.target.value as SessionProfileShellKind,
            })
          }
          data-testid={`settings-profile-shell-kind-${testIdSuffix}`}
        >
          <option value="zsh">{t('settings.sessionProfiles.shell.zsh')}</option>
          <option value="bash">{t('settings.sessionProfiles.shell.bash')}</option>
          <option value="fish">{t('settings.sessionProfiles.shell.fish')}</option>
          <option value="custom">{t('settings.sessionProfiles.shell.custom')}</option>
        </select>
      </label>
      {draft.shellKind === 'custom' && (
        <label className={styles.profileField}>
          <span>{t('settings.sessionProfiles.customShellLabel')}</span>
          <input
            type="text"
            className={styles.profileInput}
            value={draft.shellCustomPath}
            onChange={(e) =>
              onDraftChange({ ...draft, shellCustomPath: e.target.value })
            }
            data-testid={`settings-profile-shell-custom-${testIdSuffix}`}
          />
        </label>
      )}
      <label className={styles.profileField}>
        <span>{t('settings.sessionProfiles.cwdLabel')}</span>
        <input
          type="text"
          className={styles.profileInput}
          value={draft.cwd}
          placeholder={t('settings.sessionProfiles.cwdPlaceholder')}
          onChange={(e) => onDraftChange({ ...draft, cwd: e.target.value })}
          data-testid={`settings-profile-cwd-${testIdSuffix}`}
        />
      </label>
      <EnvRowsEditor
        rows={draft.envRows}
        onRowsChange={(next) => onDraftChange({ ...draft, envRows: next })}
        testIdSuffix={testIdSuffix}
      />
      <label className={styles.profileField}>
        <span>{t('settings.sessionProfiles.startupCommandsLabel')}</span>
        <textarea
          className={styles.profileTextarea}
          value={draft.startupCommandsText}
          onChange={(e) =>
            onDraftChange({ ...draft, startupCommandsText: e.target.value })
          }
          data-testid={`settings-profile-startup-commands-${testIdSuffix}`}
          rows={3}
        />
        <span className={styles.profileFieldHelp}>
          {t('settings.sessionProfiles.startupCommandsHelp')}
        </span>
      </label>
      <div className={styles.profileEditorActions}>
        <button
          type="button"
          className={styles.profileMiniButton}
          onClick={onCancel}
          data-testid={`settings-profile-cancel-${testIdSuffix}`}
        >
          {t('settings.sessionProfiles.cancel')}
        </button>
        <Button
          type="button"
          variant="primary"
          onClick={onSave}
          data-testid={`settings-profile-save-${testIdSuffix}`}
        >
          {t('settings.sessionProfiles.save')}
        </Button>
      </div>
    </div>
  );
}

interface EnvRowsEditorProps {
  readonly rows: readonly EnvRow[];
  readonly onRowsChange: (next: readonly EnvRow[]) => void;
  readonly testIdSuffix: string;
}

/**
 * Two-column KEY/VALUE table with add/remove row buttons and on-blur
 * validation of the KEY against {@link isValidEnvKey}. Row keys are only
 * reported as invalid after the user tabs away from the field so we do not
 * harass them mid-typing.
 */
function EnvRowsEditor({ rows, onRowsChange, testIdSuffix }: EnvRowsEditorProps) {
  const [blurredRowIds, setBlurredRowIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const markBlurred = useCallback((rowId: string) => {
    setBlurredRowIds((prev) => {
      if (prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });
  }, []);
  const addRow = useCallback(() => {
    if (rows.length >= MAX_STARTUP_ENV_ENTRIES) return;
    onRowsChange([...rows, { id: newEnvRowId(), key: '', value: '' }]);
  }, [onRowsChange, rows]);
  const removeRow = useCallback(
    (id: string) => {
      onRowsChange(rows.filter((r) => r.id !== id));
    },
    [onRowsChange, rows],
  );
  const capReached = rows.length >= MAX_STARTUP_ENV_ENTRIES;
  return (
    <div className={styles.profileField}>
      <span>{t('settings.sessionProfiles.envLabel')}</span>
      <div
        className={styles.envRows}
        data-testid={`settings-profile-env-${testIdSuffix}`}
      >
        {rows.map((row, idx) => {
          const trimmed = row.key.trim();
          const keyInvalid =
            blurredRowIds.has(row.id) && trimmed.length > 0 && !isValidEnvKey(trimmed);
          return (
            <div key={row.id} className={styles.envRow}>
              <input
                type="text"
                className={cx(styles.profileInput, keyInvalid && styles.profileInputError)}
                value={row.key}
                placeholder={t('settings.sessionProfiles.envKeyPlaceholder')}
                aria-invalid={keyInvalid || undefined}
                onChange={(e) => {
                  const next = rows.map((r, i) =>
                    i === idx ? { ...r, key: e.target.value } : r,
                  );
                  onRowsChange(next);
                }}
                onBlur={() => markBlurred(row.id)}
                data-testid={`settings-profile-env-key-${testIdSuffix}-${idx}`}
              />
              <input
                type="text"
                className={styles.profileInput}
                value={row.value}
                placeholder={t('settings.sessionProfiles.envValuePlaceholder')}
                onChange={(e) => {
                  const next = rows.map((r, i) =>
                    i === idx ? { ...r, value: e.target.value } : r,
                  );
                  onRowsChange(next);
                }}
                data-testid={`settings-profile-env-value-${testIdSuffix}-${idx}`}
              />
              <button
                type="button"
                className={styles.profileMiniButton}
                onClick={() => removeRow(row.id)}
                aria-label={t('settings.sessionProfiles.envRemoveRow')}
                data-testid={`settings-profile-env-remove-${testIdSuffix}-${idx}`}
              >
                ×
              </button>
              {keyInvalid && (
                <span
                  className={styles.profileFieldError}
                  data-testid={`settings-profile-env-error-${testIdSuffix}-${idx}`}
                >
                  {t('settings.sessionProfiles.envKeyInvalid')}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <button
          type="button"
          className={styles.profileMiniButton}
          onClick={addRow}
          disabled={capReached}
          data-testid={`settings-profile-env-add-${testIdSuffix}`}
        >
          {t('settings.sessionProfiles.envAddRow')}
        </button>
        {capReached && (
          <span
            className={styles.profileFieldHelp}
            data-testid={`settings-profile-env-cap-${testIdSuffix}`}
          >
            {' '}
            {t('settings.sessionProfiles.envCapReached')}
          </span>
        )}
      </div>
    </div>
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

/**
 * WorkspaceSnapshotsSection — lists the named snapshots with restore/delete
 * buttons and shows the auto snapshot separately. An "auto-restore on launch"
 * toggle sits at the top. Snapshots are sourced from
 * `useWorkspaceSnapshotStore`; the feature's IDB round-trip happens
 * transparently behind `saveSnapshot` / `deleteSnapshot`.
 */
function WorkspaceSnapshotsSection() {
  const snapshots = useWorkspaceSnapshotStore((s) => s.snapshots);
  const autoRestore = useWorkspaceSnapshotStore((s) => s.autoRestore);
  const setAutoRestore = useWorkspaceSnapshotStore((s) => s.setAutoRestore);
  const deleteSnapshot = useWorkspaceSnapshotStore((s) => s.deleteSnapshot);

  const split = useMemo(() => splitSnapshots(snapshots), [snapshots]);

  const handleSave = useCallback(async () => {
    const name = typeof window !== 'undefined'
      ? window.prompt(t('workspaceSnapshot.prompt.saveName'), '')
      : null;
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await saveNamedSnapshot(trimmed);
    } catch {
      // `saveNamedSnapshot` throws on reserved / empty name. The palette path
      // shows a toast — here we just silently no-op since the user can retry.
    }
  }, []);

  const handleRestore = useCallback(async (snap: WorkspaceSnapshot) => {
    const bridge = tryGetHostBridge();
    await restoreWorkspaceSnapshot({
      snapshot: snap,
      ...(bridge ? { bridge } : {}),
    });
  }, []);

  return (
    <section className={styles.section} aria-labelledby="qt-settings-workspace-snapshots">
      <h3 id="qt-settings-workspace-snapshots" className={styles.sectionTitle}>
        {t('workspaceSnapshot.settings.sectionTitle')}
      </h3>
      <p className={styles.sectionDescription}>
        {t('workspaceSnapshot.settings.description')}
      </p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={autoRestore}
            onChange={(e) => setAutoRestore(e.target.checked)}
            data-testid="settings-workspace-snapshot-auto-restore"
          />{' '}
          {t('workspaceSnapshot.settings.autoRestoreLabel')}
        </label>
      </div>
      <div className={styles.statusRow}>
        <Button
          type="button"
          variant="primary"
          onClick={() => void handleSave()}
          data-testid="settings-workspace-snapshot-save"
        >
          {t('workspaceSnapshot.settings.save')}
        </Button>
      </div>
      <div className={styles.profileList} data-testid="settings-workspace-snapshot-auto">
        <p className={styles.sectionDescription}>
          <strong>{t('workspaceSnapshot.settings.autoSectionTitle')}</strong>
        </p>
        {split.auto ? (
          <div
            className={styles.profileRow}
            data-testid="settings-workspace-snapshot-auto-row"
          >
            <div className={styles.profileRowInfo}>
              <div className={styles.profileName}>
                <span>{t('workspaceSnapshot.palette.save').replace('...', '')}</span>
              </div>
              <div className={styles.profileMeta}>
                {t('workspaceSnapshot.settings.autoCapturedAt', {
                  when: new Date(split.auto.createdAt).toLocaleString(),
                })}
                {' · '}
                {t('workspaceSnapshot.settings.sessionCount', {
                  count: split.auto.sessions.length,
                })}
              </div>
            </div>
            <div className={styles.profileActions}>
              <button
                type="button"
                className={styles.profileMiniButton}
                onClick={() => void handleRestore(split.auto as WorkspaceSnapshot)}
                data-testid="settings-workspace-snapshot-auto-restore-button"
              >
                {t('workspaceSnapshot.settings.restore')}
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.sectionDescription}>
            {t('workspaceSnapshot.settings.autoEmpty')}
          </p>
        )}
      </div>
      <div
        className={styles.profileList}
        data-testid="settings-workspace-snapshot-named"
      >
        <p className={styles.sectionDescription}>
          <strong>{t('workspaceSnapshot.settings.namedSectionTitle')}</strong>
        </p>
        {split.named.length === 0 ? (
          <p className={styles.sectionDescription}>
            {t('workspaceSnapshot.settings.namedEmpty')}
          </p>
        ) : (
          split.named.map((snap) => (
            <div
              key={snap.id}
              className={styles.profileRow}
              data-testid={`settings-workspace-snapshot-row-${snap.id}`}
            >
              <div className={styles.profileRowInfo}>
                <div className={styles.profileName}>
                  <span>{snap.name}</span>
                </div>
                <div className={styles.profileMeta}>
                  {new Date(snap.createdAt).toLocaleString()}
                  {' · '}
                  {t('workspaceSnapshot.settings.sessionCount', {
                    count: snap.sessions.length,
                  })}
                </div>
              </div>
              <div className={styles.profileActions}>
                <button
                  type="button"
                  className={styles.profileMiniButton}
                  onClick={() => void handleRestore(snap)}
                  data-testid={`settings-workspace-snapshot-restore-${snap.id}`}
                >
                  {t('workspaceSnapshot.settings.restore')}
                </button>
                <button
                  type="button"
                  className={styles.profileMiniButton}
                  onClick={() => void deleteSnapshot(snap.id)}
                  data-testid={`settings-workspace-snapshot-delete-${snap.id}`}
                >
                  {t('workspaceSnapshot.settings.delete')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * Font section — family dropdown, pixel-size slider, programming-ligature
 * toggle. A small live preview renders a representative sample (a shell
 * command + a ligature-rich snippet) so the user can judge the face's look
 * before committing. All three controls write straight through to the
 * `useFontSettings` store, which applies CSS vars on `:root` synchronously.
 */
function FontSection() {
  const family = useFontSettings((s) => s.family);
  const size = useFontSettings((s) => s.size);
  const ligatures = useFontSettings((s) => s.ligatures);
  const setFamily = useFontSettings((s) => s.setFamily);
  const setSize = useFontSettings((s) => s.setSize);
  const toggleLigatures = useFontSettings((s) => s.toggleLigatures);
  return (
    <section className={styles.section} aria-labelledby="qt-settings-font">
      <h3 id="qt-settings-font" className={styles.sectionTitle}>
        {t('settings.sections.font')}
      </h3>
      <p className={styles.sectionDescription}>{t('settings.font.description')}</p>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel} htmlFor="qt-settings-font-family">
          {t('settings.font.familyLabel')}
        </label>
        <select
          id="qt-settings-font-family"
          className={styles.profileSelect}
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          data-testid="settings-font-family"
        >
          {FONT_FAMILY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel} htmlFor="qt-settings-font-size">
          {t('settings.font.sizeLabel')}
          <input
            id="qt-settings-font-size"
            type="range"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            data-testid="settings-font-size"
          />{' '}
          <span data-testid="settings-font-size-value">
            {t('settings.font.sizePx', { size })}
          </span>
        </label>
      </div>
      <div className={styles.statusRow}>
        <label className={styles.shortcutLabel}>
          <input
            type="checkbox"
            checked={ligatures}
            onChange={() => toggleLigatures()}
            data-testid="settings-font-ligatures"
          />{' '}
          {t('settings.font.ligaturesLabel')}
        </label>
      </div>
      <div className={styles.statusRow}>
        <span className={styles.shortcutLabel}>{t('settings.font.previewLabel')}</span>
      </div>
      <pre
        className={styles.fontPreview}
        data-testid="settings-font-preview"
        aria-label={t('settings.font.previewLabel')}
      >
        {`cat > ~/.zshrc  # => !== <= >= -> fn() { x ?? y }`}
      </pre>
      <p className={styles.privacyNote}>{t('settings.font.fallbackNote')}</p>
    </section>
  );
}
