/**
 * Command-palette entry — "Explain last failure".
 *
 * Picks the most recent block (scanning `order` from tail to head) whose
 * status is terminal AND exitCode is non-zero, then dispatches the
 * `quanta:explain-block` DOM event. The panel for that block listens for
 * the event and triggers its own `explain()`.
 *
 * Dispatching via the same event the AiExplainPanel already listens for
 * keeps the palette decoupled from the hook; the alternative (directly
 * calling `getSuggestionPort().explainError(...)`) would bypass the panel's
 * state machine entirely and leave the UI unaware that a request fired.
 *
 * The command returns silently when no failed block exists; it does not
 * raise a toast (the palette has no toast host wired to it in this pass).
 */

import { t } from '../../shared/i18n/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import {
  EXPLAIN_BLOCK_EVENT,
  type ExplainBlockEventDetail,
} from './AiExplainPanel.js';

export const EXPLAIN_LAST_FAILURE_COMMAND_ID = 'ai.explainLastFailure';

export interface ExplainLastFailureCommand {
  readonly id: string;
  readonly label: string;
  readonly section: 'actions';
  readonly description?: string;
  readonly hint?: readonly string[];
  readonly run?: () => void;
}

/**
 * Scan the store for the most recent failed block. Exported for tests so
 * the picking policy stays decoupled from the palette wiring.
 */
export function pickLastFailedBlockId(): string | null {
  const state = useBlockStore.getState();
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const id = state.order[i];
    if (!id) continue;
    const b = state.entities[id];
    if (!b) continue;
    if (b.status === 'running') continue;
    if (b.exitCode === null) continue;
    if (b.exitCode === 0) continue;
    return b.id;
  }
  return null;
}

export function createExplainLastFailureCommand(): ExplainLastFailureCommand {
  return {
    id: EXPLAIN_LAST_FAILURE_COMMAND_ID,
    label: t('palette.explainLastFailure'),
    section: 'actions',
    description: t('palette.explainLastFailure.description'),
    run: () => {
      const blockId = pickLastFailedBlockId();
      if (!blockId) return;
      if (typeof window === 'undefined') return;
      const detail: ExplainBlockEventDetail = { blockId };
      window.dispatchEvent(
        new CustomEvent<ExplainBlockEventDetail>(EXPLAIN_BLOCK_EVENT, { detail }),
      );
    },
  };
}

export function extendPaletteWithExplainLastFailure<T extends { readonly id: string }>(
  commands: readonly T[],
): readonly (T | ExplainLastFailureCommand)[] {
  return [...commands, createExplainLastFailureCommand()];
}
