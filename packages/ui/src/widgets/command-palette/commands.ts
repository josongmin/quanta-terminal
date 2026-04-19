/**
 * Commands — the palette's in-memory catalogue. Phase 1 ships with a fixed
 * set of placeholders (session new/close, focus terminal, toggle help). A
 * later phase lets features contribute commands via a registry.
 *
 * Sections map directly to the visual groupings; the palette renders each
 * section with a heading when it has at least one matching command.
 */

export type CommandSection = 'sessions' | 'actions' | 'history';

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly section: CommandSection;
  /** Keyboard hint rendered as `<Kbd>` chips (e.g. ["⌘", "T"]). */
  readonly hint?: readonly string[];
  /** Short description shown below the label. */
  readonly description?: string;
  /** Stub action: Phase 1 handlers just console.log. */
  readonly run?: () => void;
}

export function getDefaultCommands(): readonly Command[] {
  return [
    {
      id: 'sessions.new',
      label: 'New session',
      section: 'sessions',
      hint: ['⌘', 'T'],
      description: 'Open a new shell in the current working directory',
    },
    {
      id: 'sessions.close',
      label: 'Close session',
      section: 'sessions',
      hint: ['⌘', 'W'],
      description: 'End the active shell — confirmation required',
    },
    {
      id: 'actions.focus-terminal',
      label: 'Focus terminal',
      section: 'actions',
      hint: ['⌘', '`'],
      description: 'Move keyboard focus to the terminal surface',
    },
    {
      id: 'actions.clear',
      label: 'Clear terminal',
      section: 'actions',
      hint: ['⌘', 'K'],
      description: 'Send a clear sequence to the active shell',
    },
    {
      id: 'actions.open-settings',
      label: 'Open settings',
      section: 'actions',
      description: 'Preferences, keymap, and appearance',
    },
  ];
}

/**
 * Filter the catalogue against a query. Empty query returns the full set.
 * The match is substring-insensitive on label and description — fuzzy
 * matching is a later phase, but the scoring surface is ready.
 */
export function filterCommands(
  commands: readonly Command[],
  query: string,
): readonly Command[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return commands;
  return commands.filter((c) => {
    if (c.label.toLowerCase().includes(q)) return true;
    if (c.description && c.description.toLowerCase().includes(q)) return true;
    return false;
  });
}

import { t } from '../../shared/i18n/index.js';

export const SECTION_ORDER: readonly CommandSection[] = ['sessions', 'actions', 'history'];
export const SECTION_TITLE: Readonly<Record<CommandSection, string>> = {
  sessions: t('commandPalette.section.sessions'),
  actions: t('commandPalette.section.actions'),
  history: t('commandPalette.section.history'),
};
