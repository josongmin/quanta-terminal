/**
 * "Ask AI" Command Palette entry.
 *
 * Phase 5 ships a single palette action that prompts the user for a
 * natural-language question, asks the installed provider, and drops the
 * result into the `entities/ai` store so the SuggestionBar picks it up.
 *
 * The palette widget itself is not modified — `getDefaultCommands()` in
 * `widgets/command-palette/commands.ts` remains the owner of the built-in
 * catalogue. Pages that want to expose "Ask AI" compose an extended
 * catalogue by calling `extendPaletteWithAskAi(commands)` from this module.
 *
 * Keeping the helper here (in the feature slice) means the widget does not
 * grow an import into the feature layer, which would violate FSD layer
 * order (widgets → features is forbidden). The page-level composition is
 * allowed to combine both.
 */

import { useAiStore } from '../../entities/ai/index.js';
import { getSuggestionPort } from './provider-port.js';

export const ASK_AI_COMMAND_ID = 'ai.ask';

/**
 * Minimal Command shape compatible with `widgets/command-palette/commands.ts`.
 * Duplicating the shape here (rather than importing it) is deliberate — the
 * feature layer must not depend on the widgets layer. The field set is
 * small and stable; if the palette's Command interface drifts the type here
 * is structurally compatible as long as the fields remain.
 */
export interface AskAiCommand {
  readonly id: string;
  readonly label: string;
  readonly section: 'actions' | 'history' | 'sessions';
  readonly description?: string;
  readonly hint?: readonly string[];
  readonly run?: () => void;
}

export interface AskAiOptions {
  /** Prompt the user via this function. Tests pass a canned string; the
   *  default uses `window.prompt` so the widget boots end-to-end without
   *  a richer modal. */
  readonly ask?: (placeholder: string) => string | null;
  /** Optional cwd hint forwarded to the provider. */
  readonly cwd?: string;
  /** Called after a suggestion is stored. Lets the caller e.g. focus the
   *  suggestion-bar after the modal closes. */
  readonly onSuggested?: () => void;
}

/**
 * Produce the palette command entry for "Ask AI". The `run` handler prompts,
 * fires the provider, and stores the result in the ai store.
 */
export function createAskAiCommand(options: AskAiOptions = {}): AskAiCommand {
  const askFn =
    options.ask ??
    ((placeholder: string) => {
      if (typeof window === 'undefined') return null;
      return window.prompt(placeholder, '');
    });
  return {
    id: ASK_AI_COMMAND_ID,
    label: 'Ask AI for a command',
    section: 'actions',
    description: 'Describe what you want; the AI suggests a command.',
    hint: ['⌘', 'I'],
    run: () => {
      const prompt = askFn('Ask AI: what should the command do?');
      if (!prompt || !prompt.trim()) return;
      const port = getSuggestionPort();
      port
        .suggest({ prompt: prompt.trim(), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) })
        .then((suggestion) => {
          useAiStore.getState().setSuggestion(suggestion);
          options.onSuggested?.();
        })
        .catch(() => {
          // The bar is already hidden on error; a full toast treatment lands
          // when features/toasts ships. Swallow here so a provider outage
          // doesn't take down the palette.
        });
    },
  };
}

/**
 * Append the Ask AI command to an existing palette catalogue. Returns a new
 * array so callers can pass it straight to `<CommandPalette commands={…} />`.
 */
export function extendPaletteWithAskAi<T extends { readonly id: string }>(
  commands: readonly T[],
  options?: AskAiOptions,
): readonly (T | AskAiCommand)[] {
  return [...commands, createAskAiCommand(options)];
}
