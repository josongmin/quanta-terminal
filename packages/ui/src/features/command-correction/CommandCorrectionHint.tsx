/**
 * CommandCorrectionHint — the subtle "did you mean `ls`?" hint rendered
 * below a BlockCard whose command failed with exit code 127 (command not
 * found).
 *
 * Behavior
 * --------
 * - Reads the block via `useBlockHeader(blockId)` so it tracks the same
 *   chrome-only slice the card subscribes to. A header-only update (collapse,
 *   pin) does not re-run this hint's `suggestCorrection` call.
 * - Aggregates the current block list into `CorrectionHistoryEntry` shape,
 *   mirroring the autosuggest history adapter. Same pattern, same cost
 *   envelope — we only rebuild when the id list changes.
 * - Renders only when: status is terminal, exitCode === 127, and
 *   `suggestCorrection` returns a `Correction`. Single-word gate lives inside
 *   `suggestCorrection`; this component adds no duplicate guard.
 * - Clicking "Rerun with this" submits the corrected command through the
 *   caller's `onRerun` callback (same shape as BlockCard's onRerun).
 * - Dismissal is local state only. Per the scope rules, we never persist
 *   across reloads.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { t } from '../../shared/i18n/index.js';
import {
  useBlockHeader,
  useBlockIds,
  useBlockStore,
  type Block,
} from '../../entities/block/index.js';
import { suggestCorrection, type CorrectionHistoryEntry } from './suggest.js';
import styles from './command-correction-hint.module.css';

export interface CommandCorrectionHintProps {
  /** Block whose exit code is being inspected. */
  readonly blockId: string;
  /**
   * Invoked when the user accepts the suggestion. The second argument is the
   * corrected command text — callers should submit it through whatever
   * pathway they already use for rerun. The original block id lets analytics
   * correlate the suggestion with its source.
   */
  readonly onRerunWithCorrection: (blockId: string, correctedCommand: string) => void;
}

/**
 * Aggregate all non-running blocks into `CorrectionHistoryEntry` shape.
 * Mirrors `features/autosuggest/history-source.ts::buildHistoryEntries` —
 * we keep a local copy here rather than importing to avoid creating a
 * cross-slice import edge between two sibling features (FSD rules, ADR 0014).
 */
function buildCorrectionHistory(blocks: readonly Block[]): CorrectionHistoryEntry[] {
  const byKey = new Map<string, CorrectionHistoryEntry>();
  for (const b of blocks) {
    if (b.status === 'running') continue;
    const command = b.command.trim();
    if (command.length === 0) continue;
    const key = `${command}\u0000${b.cwd}`;
    const ts = b.completedAt ?? b.startedAt;
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        command,
        cwd: b.cwd,
        runCount: prev.runCount + 1,
        lastRunAt: Math.max(prev.lastRunAt, ts),
      });
    } else {
      byKey.set(key, { command, cwd: b.cwd, runCount: 1, lastRunAt: ts });
    }
  }
  return [...byKey.values()];
}

function CommandCorrectionHintImpl(props: CommandCorrectionHintProps) {
  const { blockId, onRerunWithCorrection } = props;
  const header = useBlockHeader(blockId);
  const [dismissed, setDismissed] = useState(false);

  // Subscribe to the id list only; rebuild the history aggregate at memo time
  // from `getState().entities`. Writing a running block's chunks bumps the
  // entities map but leaves the order unchanged — we do NOT want to recompute
  // the typo/history ranking on every streamed byte.
  const ids = useBlockIds();
  const history = useMemo(() => {
    const entities = useBlockStore.getState().entities;
    const blocks: Block[] = [];
    for (const id of ids) {
      const b = entities[id];
      if (!b) continue;
      // Skip the failing block itself — it's the source of the correction
      // and its presence in history would bias the ranker toward exact
      // self-matches (filtered in suggest.ts anyway, but cheaper to skip).
      if (b.id === blockId) continue;
      blocks.push(b);
    }
    return buildCorrectionHistory(blocks);
  }, [ids, blockId]);

  const correction = useMemo(() => {
    if (!header) return null;
    if (header.status !== 'completed' && header.status !== 'error') return null;
    if (header.exitCode !== 127) return null;
    return suggestCorrection({
      command: header.command,
      cwd: header.cwd,
      history,
    });
    // header fields that matter: exitCode, status, command, cwd. Dependency
    // on `header` is a single shallow-equal object, so this memo re-runs only
    // when the card's chrome slice actually changes.
  }, [header, history]);

  const onRerunClick = useCallback(() => {
    if (!correction || !header) return;
    onRerunWithCorrection(header.id, correction.suggested);
  }, [correction, header, onRerunWithCorrection]);

  const onDismissClick = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!header) return null;
  if (dismissed) return null;
  if (!correction) return null;

  return (
    <div
      className={styles.hint}
      data-testid={`command-correction-hint-${blockId}`}
      data-confidence={correction.confidence}
      data-source={correction.source}
      role="status"
    >
      <span className={styles.text}>
        {t('blockCard.didYouMean.question')}{' '}
        <code><Kbd>{correction.suggested}</Kbd></code>
        {'?'}
      </span>
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.rerunButton}
          onClick={onRerunClick}
          aria-label={`${t('blockCard.didYouMean.rerun')} ${correction.suggested}`}
          data-testid={`command-correction-rerun-${blockId}`}
        >
          {t('blockCard.didYouMean.rerun')}
        </button>
        <button
          type="button"
          className={styles.dismissButton}
          onClick={onDismissClick}
          aria-label={t('blockCard.didYouMean.dismiss')}
          data-testid={`command-correction-dismiss-${blockId}`}
        >
          ×
        </button>
      </span>
    </div>
  );
}

/**
 * Memoized — the hint re-subscribes to the block header via its own hook, so
 * the only reason the outer component would re-render is a new `blockId` or
 * a new `onRerunWithCorrection` identity. Both are stable in the normal
 * BlockCard call path.
 */
export const CommandCorrectionHint = memo(CommandCorrectionHintImpl, (prev, next) => {
  return (
    prev.blockId === next.blockId && prev.onRerunWithCorrection === next.onRerunWithCorrection
  );
});

CommandCorrectionHint.displayName = 'CommandCorrectionHint';
