/**
 * KeybindingRow — a single row in the Shortcuts settings section.
 *
 * Layout:
 *   [ action label ........... <Kbd>current shortcut</Kbd>  [Record] [Reset] [conflict badge] ]
 *
 * Record opens a modal overlay that listens for the next keydown via the
 * `captureNextShortcut` helper. Reset clears the override (visible only when
 * overridden). The conflict badge appears when another binding resolves to
 * the same canonical shortcut; hover reveals the other action's label.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '../../shared/ui/badge/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { formatShortcutHint } from '../../shared/lib/keymap.js';
import { t, type StringKey } from '../../shared/i18n/index.js';

import { captureNextShortcut } from './record.js';
import type { KeybindingDefinition } from './registry.js';
import { useKeybindingsStore } from './store.js';

export interface KeybindingRowProps {
  readonly definition: KeybindingDefinition;
  /** Current effective shortcut (override if present, else default). */
  readonly shortcut: string;
  /** True when the user has overridden this binding — controls Reset visibility. */
  readonly isOverridden: boolean;
  /** Labels of the actions this binding conflicts with. Empty when clean. */
  readonly conflictWith: ReadonlyArray<StringKey>;
  /** CSS module — passed from the section so we don't duplicate styles. */
  readonly styles: Readonly<Record<string, string>>;
}

export function KeybindingRow(props: KeybindingRowProps) {
  const { definition, shortcut, isOverridden, conflictWith, styles } = props;
  const setOverride = useKeybindingsStore((s) => s.setOverride);
  const clearOverride = useKeybindingsStore((s) => s.clearOverride);
  const [recording, setRecording] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const recordButtonRef = useRef<HTMLButtonElement | null>(null);

  // On unmount, cancel any in-flight recording so the listener is torn down.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Move focus into overlay when recording starts.
  useEffect(() => {
    if (recording) {
      overlayRef.current?.focus();
    }
  }, [recording]);

  const startRecord = useCallback(() => {
    if (recording) return;
    setRecording(true);
    const controller = new AbortController();
    abortRef.current = controller;
    void captureNextShortcut({ signal: controller.signal }).then((result) => {
      abortRef.current = null;
      setRecording(false);
      if (result !== null) setOverride(definition.id, result);
      // Return focus to the Record button once recording ends.
      recordButtonRef.current?.focus();
    });
  }, [recording, setOverride, definition.id]);

  const cancelRecord = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    clearOverride(definition.id);
  }, [clearOverride, definition.id]);

  const hint = formatShortcutHint(shortcut);
  const hasConflict = conflictWith.length > 0;

  return (
    <div
      className={styles.keybindingRow}
      data-testid={`keybinding-row-${definition.id}`}
      data-conflict={hasConflict ? 'true' : undefined}
    >
      <span className={styles.keybindingLabel}>{t(definition.labelKey)}</span>
      <span className={styles.keybindingCurrent}>
        <Kbd data-testid={`keybinding-current-${definition.id}`}>{hint}</Kbd>
        {hasConflict ? (
          <Badge
            label={t('keybindings.conflictBadge')}
            tone="warning"
            title={t('keybindings.conflictWarning', {
              actions: conflictWith.map((k) => t(k)).join(', '),
            })}
            data-testid={`keybinding-conflict-${definition.id}`}
            srDescription={t('keybindings.conflictWarning', {
              actions: conflictWith.map((k) => t(k)).join(', '),
            })}
          />
        ) : null}
      </span>
      <span className={styles.keybindingActions}>
        <button
          ref={recordButtonRef}
          type="button"
          className={styles.keybindingMiniButton}
          onClick={recording ? cancelRecord : startRecord}
          data-testid={`keybinding-record-${definition.id}`}
          aria-pressed={recording}
        >
          {recording ? t('keybindings.recording') : t('keybindings.record')}
        </button>
        {isOverridden ? (
          <button
            type="button"
            className={styles.keybindingMiniButton}
            onClick={reset}
            data-testid={`keybinding-reset-${definition.id}`}
          >
            {t('keybindings.reset')}
          </button>
        ) : null}
      </span>
      {recording ? (
        <div
          ref={overlayRef}
          className={styles.keybindingOverlay}
          role="dialog"
          aria-modal="true"
          aria-label={t('keybindings.recordHint')}
          data-testid={`keybinding-overlay-${definition.id}`}
          tabIndex={-1}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <p className={styles.keybindingOverlayHint}>{t('keybindings.recordHint')}</p>
        </div>
      ) : null}
    </div>
  );
}

KeybindingRow.displayName = 'KeybindingRow';
