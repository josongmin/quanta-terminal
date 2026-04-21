/**
 * `useExplainShortcut` — focused-card keyboard hook for the AI explain
 * panel. When the user presses `E` (no modifiers, not inside a typing
 * target) while a descendant of the owning card has focus, we fire the
 * explain request.
 *
 * Mirrors the focus-gated pattern used by `useBlockTagEditorShortcut` and
 * `useBlockCopyAsMarkdownShortcut` in BlockCard — one global listener via
 * `subscribeKeymap`, per-card gating via an article ref.
 *
 * The hook is defensive in two ways:
 *   - Only fires when the block is in a failed terminal state (exitCode
 *     non-zero). Pressing E on a successful block is a no-op.
 *   - Respects the `aiExplainEnabled` setting so a user who disabled the
 *     feature doesn't get surprise requests from the shortcut.
 */

import { useEffect, type RefObject } from 'react';
import { subscribeKeymap } from '../../shared/lib/keymap.js';
import { useBlockStore } from '../../entities/block/index.js';
import { useAiExplainSettings } from './settings.js';
import {
  EXPLAIN_BLOCK_EVENT,
  type ExplainBlockEventDetail,
} from './AiExplainPanel.js';

export interface UseExplainShortcutOptions {
  readonly articleRef: RefObject<HTMLElement | null>;
  readonly blockId: string;
}

export function useExplainShortcut(options: UseExplainShortcutOptions): void {
  const { articleRef, blockId } = options;
  useEffect(() => {
    const sub = subscribeKeymap({
      shortcut: 'e',
      handler: () => {
        const article = articleRef.current;
        if (!article) return;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!active || !article.contains(active)) return;
        // Defensive guards — the shortcut must only trigger for a failed,
        // terminal block AND with the feature setting on.
        if (!useAiExplainSettings.getState().enabled) return;
        const block = useBlockStore.getState().entities[blockId];
        if (!block) return;
        if (block.status === 'running') return;
        if (block.exitCode === null || block.exitCode === 0) return;
        if (typeof window === 'undefined') return;
        const detail: ExplainBlockEventDetail = { blockId };
        window.dispatchEvent(
          new CustomEvent<ExplainBlockEventDetail>(EXPLAIN_BLOCK_EVENT, { detail }),
        );
      },
      allowInEditable: false,
    });
    return () => sub.unsubscribe();
  }, [articleRef, blockId]);
}
