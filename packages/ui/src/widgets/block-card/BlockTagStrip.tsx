/**
 * BlockTagStrip — the row of tag chips rendered under a BlockCard's header.
 *
 * UX contract
 * -----------
 * - Each tag shows as a neutral-tone pill. Hovering the pill exposes an
 *   inline `×` remove button. Clicking the pill (outside the `×`) toggles
 *   the tag in the global filter (entities/block-filter). This is the
 *   Warp-style "add tag to filter by clicking a chip" behavior.
 * - The trailing `+` button opens a small portaled popover anchored to the
 *   button. Inside is a single input with typeahead over `listAllTags()`
 *   (frequency-ordered). Pressing Enter either picks the highlighted
 *   suggestion OR — when the input text is a valid brand-new tag —
 *   creates it on the block. Escape closes.
 *
 * Scope discipline (per prompt)
 * -----------------------------
 * - No colors on tags. All chips share the same tone — extension point
 *   noted in a TODO.
 * - No tag renaming. The `×` removes the tag from THIS block; it does not
 *   touch the tag's use on other blocks.
 *
 * Controllable entry point
 * ------------------------
 * The `openSignal` prop is a monotonically-increasing counter the parent
 * bumps to force the popover open (T-key keyboard shortcut flow). Using a
 * counter rather than a boolean avoids the "already-open, bump it again"
 * edge case — each bump causes an effect to fire deterministically.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  isValidTag,
  normalizeTag,
  useAllTags,
  useBlockStore,
  type TagFrequency,
} from '../../entities/block/index.js';
import { useBlockFilterStore } from '../../entities/block-filter/index.js';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import styles from './block-tag-strip.module.css';

export interface BlockTagStripProps {
  readonly blockId: string;
  readonly tags: readonly string[];
  /**
   * Monotonic counter — when it increases, the popover opens (used by the
   * `T` keyboard shortcut). Starts at 0 and is incremented imperatively.
   */
  readonly openSignal?: number;
}

function BlockTagStripImpl(props: BlockTagStripProps) {
  const { blockId, tags, openSignal = 0 } = props;
  const addTag = useBlockStore((s) => s.addTag);
  const removeTag = useBlockStore((s) => s.removeTag);
  const toggleFilterTag = useBlockFilterStore((s) => s.toggleTag);
  const allTags = useAllTags();

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number }>({ x: 0, y: 0, w: 0 });
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // Imperative "open" on every openSignal bump. We deliberately do NOT track
  // the previous value — the useEffect fires whenever the signal changes,
  // and 0→0 doesn't fire (effect only runs on deps change), so the initial
  // render stays closed.
  useEffect(() => {
    if (openSignal <= 0) return;
    const btn = addButtonRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      setAnchor({ x: r.left, y: r.bottom + 4, w: Math.max(r.width, 180) });
    }
    setOpen(true);
  }, [openSignal]);

  const onChipClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>, tag: string) => {
      e.stopPropagation();
      toggleFilterTag(tag);
    },
    [toggleFilterTag],
  );

  const onRemoveClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>, tag: string) => {
      e.stopPropagation();
      removeTag(blockId, tag);
    },
    [blockId, removeTag],
  );

  const onAddToggle = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const btn = addButtonRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      setAnchor({ x: r.left, y: r.bottom + 4, w: Math.max(r.width, 180) });
    }
    setOpen((v) => !v);
  }, []);

  const onClose = useCallback(() => {
    setOpen(false);
    // Return focus to the + button so keyboard users aren't stranded.
    addButtonRef.current?.focus();
  }, []);

  // Pre-filter candidates shown in the popover — exclude tags already on
  // the block so the user doesn't see "bug" as a suggestion when the chip
  // for "bug" is already rendered next to the input.
  const candidates = useMemo<readonly TagFrequency[]>(
    () => allTags.filter((f) => !tags.includes(f.tag)),
    [allTags, tags],
  );

  const onCommitTag = useCallback(
    (raw: string): boolean => {
      const didAdd = addTag(blockId, raw);
      if (didAdd) setOpen(false);
      return didAdd;
    },
    [addTag, blockId],
  );

  return (
    <div
      className={styles.strip}
      data-testid={`block-tag-strip-${blockId}`}
      onClick={(e) => e.stopPropagation()}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className={styles.chip}
          data-testid={`block-tag-chip-${blockId}-${tag}`}
          onKeyDown={(e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              removeTag(blockId, tag);
            }
          }}
        >
          <button
            type="button"
            className={styles.chipLabel}
            onClick={(e) => onChipClick(e, tag)}
            aria-label={t('blockCard.tags.chipLabel', { tag })}
          >
            {tag}
          </button>
          <button
            type="button"
            tabIndex={0}
            className={styles.chipRemove}
            onClick={(e) => onRemoveClick(e, tag)}
            aria-label={t('blockCard.tags.removeLabel', { tag })}
            data-testid={`block-tag-remove-${blockId}-${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        ref={addButtonRef}
        type="button"
        className={cx(styles.add, open ? styles.addOpen : undefined)}
        onClick={onAddToggle}
        aria-label={t('blockCard.tags.addLabel')}
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="dialog"
        data-testid={`block-tag-add-${blockId}`}
      >
        + {t('blockCard.tags.addButton')}
      </button>
      {open && (
        <TagAddPopover
          anchor={anchor}
          candidates={candidates}
          onClose={onClose}
          onCommit={onCommitTag}
          testIdPrefix={`block-tag-popover-${blockId}`}
        />
      )}
    </div>
  );
}

export const BlockTagStrip = memo(BlockTagStripImpl);
BlockTagStrip.displayName = 'BlockTagStrip';

/* ----------------------------- Popover ------------------------------- */

interface TagAddPopoverProps {
  readonly anchor: { x: number; y: number; w: number };
  readonly candidates: readonly TagFrequency[];
  readonly onClose: () => void;
  /** Return true on successful add — the popover closes on true, keeps open
   *  on false so the user can correct an invalid input. */
  readonly onCommit: (tag: string) => boolean;
  readonly testIdPrefix: string;
}

function TagAddPopover(props: TagAddPopoverProps) {
  const { anchor, candidates, onClose, onCommit, testIdPrefix } = props;
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Filter suggestions against the typed query (substring match) and cap the
  // list so a user with hundreds of tags doesn't render a megapopover.
  const suggestions = useMemo(() => {
    const q = normalizeTag(query);
    if (q.length === 0) return candidates.slice(0, 8);
    return candidates.filter((c) => c.tag.includes(q)).slice(0, 8);
  }, [candidates, query]);

  // Auto-focus the input on open. Defensive: rAF ensures the portal is in the
  // DOM before we try to .focus().
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Close on Escape / outside click.
  useEffect(() => {
    const onDocKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onClose();
      }
    };
    const onDocClick = (ev: globalThis.MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (ev.target instanceof Node && root.contains(ev.target)) return;
      onClose();
    };
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onDocKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  // Clamp activeIdx when suggestions shrink so Enter doesn't index past end.
  useEffect(() => {
    if (activeIdx >= suggestions.length) setActiveIdx(0);
  }, [activeIdx, suggestions.length]);

  const commit = useCallback(
    (raw: string) => {
      const normalized = normalizeTag(raw);
      if (!isValidTag(normalized)) {
        setError(t('blockCard.tags.invalid'));
        return;
      }
      const ok = onCommit(normalized);
      if (!ok) {
        // Already present or store-level dedup — just close quietly.
        onClose();
      }
    },
    [onClose, onCommit],
  );

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Prefer the highlighted suggestion when one exists and the user
        // hasn't typed something that would be a "fresh" tag already.
        const hi = suggestions[activeIdx];
        if (hi && (query.trim().length === 0 || normalizeTag(query) === hi.tag)) {
          commit(hi.tag);
        } else {
          commit(query);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      }
    },
    [activeIdx, commit, query, suggestions],
  );

  // Render into a portal so the popover escapes any overflow:hidden ancestor.
  const node = (
    <div
      ref={rootRef}
      className={styles.popover}
      role="dialog"
      aria-label={t('blockCard.tags.popoverLabel')}
      style={{
        left: `${anchor.x}px`,
        top: `${anchor.y}px`,
        minWidth: `${anchor.w}px`,
      }}
      data-testid={testIdPrefix}
    >
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
        placeholder={t('blockCard.tags.inputPlaceholder')}
        maxLength={48}
        data-testid={`${testIdPrefix}-input`}
      />
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      {suggestions.length > 0 && (
        <ul className={styles.list} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.tag}
              role="option"
              aria-selected={i === activeIdx}
              className={cx(styles.listItem, i === activeIdx ? styles.listItemActive : undefined)}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                // mousedown (not click) fires before the outside-click handler
                // closes the popover — otherwise the click would be swallowed.
                e.preventDefault();
                commit(s.tag);
              }}
              data-testid={`${testIdPrefix}-option-${s.tag}`}
            >
              <span className={styles.listItemTag}>{s.tag}</span>
              <span className={styles.listItemCount}>{s.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
