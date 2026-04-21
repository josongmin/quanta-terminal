/**
 * Keybinding registry — the canonical list of app-level actions that the user
 * can customize.
 *
 * Each entry has:
 *   - `id`: stable identifier (e.g. `'palette.open'`). Persisted in the
 *     override store; MUST NOT change once released.
 *   - `label`: user-facing description. i18n-aware via `StringKey`.
 *   - `defaultShortcut`: the built-in shortcut spec (e.g. `'mod+k'`).
 *   - `scope`: `'global' | 'editor' | 'palette'` — informational for the
 *     settings UI grouping. The keymap subscriber still decides where each
 *     handler is wired; the scope here is metadata, not enforcement.
 *
 * Why a sibling file instead of appending to `shared/lib/keymap.ts`:
 * `keymap.ts` lives in the shared layer and owns the low-level listener +
 * parser. The per-action catalogue belongs to a feature layer because it
 * enumerates product-level actions (palette, new tab, …) and knows about
 * i18n labels — both of which are feature concerns, not primitives.
 */

import type { StringKey } from '../../shared/i18n/index.js';

export type KeybindingScope = 'global' | 'editor' | 'palette';

export interface KeybindingDefinition {
  readonly id: string;
  readonly labelKey: StringKey;
  readonly defaultShortcut: string;
  readonly scope: KeybindingScope;
}

/**
 * The shipping keybindings. The `id`s mirror the command palette's command
 * ids where a 1:1 mapping exists, so feature code can look up overrides by
 * the same id it uses for its action.
 *
 * Order here is the order rendered in the settings UI.
 */
export const KEYBINDING_REGISTRY: readonly KeybindingDefinition[] = [
  {
    id: 'palette.open',
    labelKey: 'keybindings.action.palette',
    defaultShortcut: 'mod+p',
    scope: 'global',
  },
  {
    id: 'sessions.new',
    labelKey: 'keybindings.action.newSession',
    defaultShortcut: 'mod+t',
    scope: 'global',
  },
  {
    id: 'sessions.close',
    labelKey: 'keybindings.action.closeSession',
    defaultShortcut: 'mod+w',
    scope: 'global',
  },
  {
    id: 'session.splitRight',
    labelKey: 'keybindings.action.splitRight',
    defaultShortcut: 'mod+shift+d',
    scope: 'global',
  },
  {
    id: 'pane.zoom',
    labelKey: 'keybindings.action.zoomPane',
    defaultShortcut: 'mod+shift+enter',
    scope: 'global',
  },
  {
    id: 'output.search',
    labelKey: 'keybindings.action.outputSearch',
    defaultShortcut: 'mod+f',
    scope: 'global',
  },
  {
    id: 'history.search',
    labelKey: 'keybindings.action.historySearch',
    defaultShortcut: 'mod+shift+f',
    scope: 'global',
  },
  {
    id: 'settings.open',
    labelKey: 'keybindings.action.settings',
    defaultShortcut: 'mod+,',
    scope: 'global',
  },
  {
    id: 'terminal.clear',
    labelKey: 'keybindings.action.clearTerminal',
    defaultShortcut: 'mod+k',
    scope: 'global',
  },
  {
    id: 'terminal.focus',
    labelKey: 'keybindings.action.focusTerminal',
    defaultShortcut: 'mod+`',
    scope: 'global',
  },
];

/** Look up a definition by id. Returns undefined for unknown ids. */
export function findKeybinding(id: string): KeybindingDefinition | undefined {
  return KEYBINDING_REGISTRY.find((k) => k.id === id);
}
