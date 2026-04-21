/**
 * KeybindingsSection — the "Shortcuts" section in SettingsPanel.
 *
 * Renders one `KeybindingRow` per registry entry plus a global "Reset all"
 * button below. Conflicts are computed once per render from the store's
 * override map and distributed to rows via props (cheaper than every row
 * re-running the same scan).
 */

import { useMemo } from 'react';

import { t } from '../../shared/i18n/index.js';

import { conflictsFor, detectConflicts } from './conflicts.js';
import { KeybindingRow } from './KeybindingRow.js';
import { findKeybinding, KEYBINDING_REGISTRY } from './registry.js';
import { useKeybindingsStore } from './store.js';

import styles from './keybindings-section.module.css';

export function KeybindingsSection() {
  const overrides = useKeybindingsStore((s) => s.overrides);
  const resetAll = useKeybindingsStore((s) => s.reset);

  const conflicts = useMemo(() => detectConflicts(overrides), [overrides]);
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <section className={styles.section} aria-labelledby="qt-settings-keybindings">
      <h3 id="qt-settings-keybindings" className={styles.sectionTitle}>
        {t('settings.sections.keybindings')}
      </h3>
      <p className={styles.sectionDescription}>{t('keybindings.description')}</p>
      <div className={styles.keybindingList} data-testid="keybindings-list">
        {KEYBINDING_REGISTRY.map((def) => {
          const shortcut = overrides[def.id] ?? def.defaultShortcut;
          const conflictIds = conflictsFor(def.id, conflicts);
          const conflictLabels = conflictIds
            .map((id) => findKeybinding(id)?.labelKey)
            .filter((k): k is NonNullable<typeof k> => k !== undefined);
          return (
            <KeybindingRow
              key={def.id}
              definition={def}
              shortcut={shortcut}
              isOverridden={def.id in overrides}
              conflictWith={conflictLabels}
              styles={styles}
            />
          );
        })}
      </div>
      {hasOverrides ? (
        <div className={styles.keybindingFooter}>
          <button
            type="button"
            className={styles.keybindingMiniButton}
            onClick={resetAll}
            data-testid="keybindings-reset-all"
          >
            {t('keybindings.resetAll')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

KeybindingsSection.displayName = 'KeybindingsSection';
