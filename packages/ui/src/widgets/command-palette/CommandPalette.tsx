/**
 * CommandPalette — centered modal overlay, Cmd/Ctrl+K to open.
 *
 * What this widget ships (Phase 1):
 *   - visual completeness (input, sections, rows with keyboard hints);
 *   - arrow-key navigation, Enter to run, Escape or outside-click to close;
 *   - focus trap + "return focus to the previously active element" on close;
 *   - an empty state when filtering yields zero results.
 *
 * What it doesn't ship (yet):
 *   - real command wiring beyond the Phase-1 catalogue (see `commands.ts`).
 *     A registry lands when features start contributing commands.
 *
 * Open/close is owned by the parent (the page wires the Cmd/Ctrl+K shortcut
 * and passes `open`). Keeping the widget controlled avoids fighting the
 * keymap for ownership of the toggle and makes testing trivial.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { cx } from '../../shared/lib/cx.js';
import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { t } from '../../shared/i18n/index.js';
import {
  filterCommands,
  getCommandHintChips,
  getDefaultCommands,
  SECTION_ORDER,
  SECTION_TITLE,
  type Command,
} from './commands.js';
import styles from './command-palette.module.css';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Optional command override. Tests and storybook pass a fixed catalogue;
   * the default is `getDefaultCommands()`.
   */
  readonly commands?: readonly Command[];
  /** Called when the user runs a command. The palette closes on run. */
  readonly onRun?: (command: Command) => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, commands = getDefaultCommands(), onRun } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Reset the index when the filtered list or the open state changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // On open: remember the previously focused element, focus the input, and
  // activate the focus trap. On close: return focus to the caller.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (!container) return;
    inputRef.current?.focus();
    const trap = activateFocusTrap(container);
    return () => {
      trap.deactivate();
      setQuery('');
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
      previouslyFocused.current = null;
    };
  }, [open]);

  const runAt = useCallback(
    (index: number) => {
      const cmd = filtered[index];
      if (!cmd) return;
      onRun?.(cmd);
      cmd.run?.();
      onClose();
    },
    [filtered, onClose, onRun],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length === 0) return;
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length === 0) return;
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runAt(activeIndex);
      }
    },
    [activeIndex, filtered.length, onClose, runAt],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Only close when the click is on the backdrop itself.
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropClick}
      data-testid="palette-backdrop"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette.dialogLabel')}
        className={styles.panel}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.inputRow}>
          <span className={styles.inputIcon} aria-hidden>
            {/* minimal "magnifier" mark; keeps the palette header visually dense without an SVG sprite */}
            ⌕
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette.searchPlaceholder')}
            aria-label={t('commandPalette.searchLabel')}
            aria-controls="quanta-palette-results"
            aria-activedescendant={
              filtered[activeIndex] ? `quanta-palette-opt-${filtered[activeIndex].id}` : undefined
            }
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          id="quanta-palette-results"
          className={styles.results}
          role="listbox"
          aria-label={t('commandPalette.resultsLabel')}
        >
          {filtered.length === 0 ? (
            <div className={styles.empty} role="status">
              {t('commandPalette.emptyHint')}
            </div>
          ) : (
            renderSections(filtered, activeIndex, (i) => setActiveIndex(i), runAt)
          )}
        </div>
      </div>
    </div>
  );
}

CommandPalette.displayName = 'CommandPalette';

/**
 * Render the keyboard-hint chip row for a command. Uses
 * `getCommandHintChips()` to pull the platform-correct chips — the helper
 * handles both the new `accelerator` spec and the legacy `hint` array.
 */
function renderHint(cmd: Command) {
  const chips = getCommandHintChips(cmd);
  if (chips.length === 0) return null;
  return (
    <div className={styles.rowHint}>
      {chips.map((k, i) => (
        <Kbd key={`${cmd.id}-h-${i}`}>{k}</Kbd>
      ))}
    </div>
  );
}

function renderSections(
  filtered: readonly Command[],
  activeIndex: number,
  onHover: (flatIndex: number) => void,
  onRun: (flatIndex: number) => void,
) {
  // Preserve the flat index so keyboard navigation lines up with visual order.
  const byId: Map<string, number> = new Map();
  filtered.forEach((c, i) => byId.set(c.id, i));

  return SECTION_ORDER.map((section) => {
    const rows = filtered.filter((c) => c.section === section);
    if (rows.length === 0) return null;
    return (
      <div key={section} className={styles.section}>
        <div className={styles.sectionHeader}>{SECTION_TITLE[section]}</div>
        <ul className={styles.sectionList}>
          {rows.map((cmd) => {
            const flatIndex = byId.get(cmd.id)!;
            const isActive = flatIndex === activeIndex;
            return (
              <li
                key={cmd.id}
                id={`quanta-palette-opt-${cmd.id}`}
                role="option"
                aria-selected={isActive}
                className={cx(styles.row, isActive && styles.rowActive)}
                onMouseEnter={() => onHover(flatIndex)}
                onClick={() => onRun(flatIndex)}
              >
                <div className={styles.rowMain}>
                  <div className={styles.rowLabel}>{cmd.label}</div>
                  {cmd.description ? (
                    <div className={styles.rowDescription}>{cmd.description}</div>
                  ) : null}
                </div>
                {renderHint(cmd)}
              </li>
            );
          })}
        </ul>
      </div>
    );
  });
}
