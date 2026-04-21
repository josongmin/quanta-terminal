/**
 * BlockFilterBar — sticky strip at the top of the BlockList when any tag
 * filter is active.
 *
 * Rendering contract
 * ------------------
 * - Hidden entirely when `activeTags.size === 0`. We do NOT render an empty
 *   placeholder — the goal is zero footprint when the feature is inert.
 * - Shows one chip per active tag with an inline `×` removing just that
 *   tag from the filter. A trailing `Clear` button resets the whole filter.
 * - A mode toggle (`Any` / `All`) flips the filter semantics in place.
 *
 * Count read
 * ----------
 * We read `matched / total` via the composed selector so the bar can
 * display "3 of 17". When the numbers match (all blocks pass) we render
 * the same "of" message — it's a cue that the filter is loose.
 */

import { memo, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import {
  useBlockFilter,
  useBlockFilterStore,
  useFilteredBlockCount,
} from '../../entities/block-filter/index.js';
import { t } from '../../shared/i18n/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './block-filter-bar.module.css';

export interface BlockFilterBarProps {
  /**
   * The pre-scoped id list (already session-filtered). Used only to compute
   * the `matched / total` counts — BlockList still owns the filtering.
   */
  readonly ids: readonly string[];
}

function BlockFilterBarImpl(props: BlockFilterBarProps) {
  const { ids } = props;
  const filter = useBlockFilter();
  const removeTag = useBlockFilterStore((s) => s.removeTag);
  const clear = useBlockFilterStore((s) => s.clear);
  const setMode = useBlockFilterStore((s) => s.setMode);
  const { matched, total } = useFilteredBlockCount(ids);

  // All hooks must run unconditionally — declare callbacks BEFORE the early
  // return so the hook count is stable across renders (filter activation
  // flipping the return path would otherwise trip React's hook invariant).
  const onClear = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      clear();
    },
    [clear],
  );

  const onRemove = useCallback(
    (e: MouseEvent<HTMLButtonElement>, tag: string) => {
      e.stopPropagation();
      removeTag(tag);
    },
    [removeTag],
  );

  const activeTags = [...filter.activeTags];
  if (activeTags.length === 0) return null;

  return (
    <div className={styles.bar} role="region" aria-label={t('blockFilter.bar.activeLabel')} data-testid="block-filter-bar">
      <span className={styles.label}>{t('blockFilter.bar.activeLabel')}:</span>
      <span className={styles.chips}>
        {activeTags.map((tag) => (
          <span
            key={tag}
            className={styles.chip}
            data-testid={`block-filter-chip-${tag}`}
            tabIndex={0}
            aria-label={t('blockFilter.bar.removeTag', { tag })}
            onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                removeTag(tag);
              }
            }}
          >
            <span className={styles.chipLabel}>{tag}</span>
            <button
              type="button"
              className={styles.chipRemove}
              onClick={(e) => onRemove(e, tag)}
              aria-label={t('blockFilter.bar.removeTag', { tag })}
              data-testid={`block-filter-chip-remove-${tag}`}
            >
              ×
            </button>
          </span>
        ))}
      </span>
      <span className={styles.modeToggle} role="group" aria-label={t('blockFilter.bar.modeLabel')}>
        <button
          type="button"
          className={cx(styles.modeButton, filter.mode === 'any' ? styles.modeButtonActive : undefined)}
          onClick={() => setMode('any')}
          aria-pressed={filter.mode === 'any'}
          data-testid="block-filter-mode-any"
        >
          {t('blockFilter.bar.modeAny')}
        </button>
        <button
          type="button"
          className={cx(styles.modeButton, filter.mode === 'all' ? styles.modeButtonActive : undefined)}
          onClick={() => setMode('all')}
          aria-pressed={filter.mode === 'all'}
          data-testid="block-filter-mode-all"
        >
          {t('blockFilter.bar.modeAll')}
        </button>
      </span>
      <span
        className={styles.count}
        data-testid="block-filter-count"
        aria-live="polite"
      >
        {t('blockFilter.bar.count', { matched, total })}
      </span>
      <button
        type="button"
        className={styles.clear}
        onClick={onClear}
        aria-label={t('blockFilter.bar.clearLabel')}
        data-testid="block-filter-clear"
      >
        {t('blockFilter.bar.clear')}
      </button>
    </div>
  );
}

export const BlockFilterBar = memo(BlockFilterBarImpl);
BlockFilterBar.displayName = 'BlockFilterBar';
