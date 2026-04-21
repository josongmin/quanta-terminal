/**
 * ComparePanel — rerun diff overlay (Phase 4).
 *
 * Mounts as a modal dialog when `useCompareStore.open` is true. Reads the
 * pair of block ids from the compare store, derives the diff + deltas via
 * `compareBlocks`, and renders:
 *
 *   - Header chips: command, duration delta, exit-code delta, bytes delta.
 *   - Truncation banner when the diff was clamped.
 *   - Body: side-by-side (>=900px) or unified (<900px) line diff with a
 *     gutter (`+` / `-` / ` `) and ANSI-styled body text per line.
 *   - Footer hint with keyboard shortcuts.
 *
 * Keyboard:
 *   - Escape closes the panel (the TerminalPage still owns the global
 *     Escape handler; we render null when `open` is false so the page's
 *     fallback cascade stays intact, but we also bind Escape locally so
 *     focused-inside-panel typing dismisses without bubbling oddly).
 *   - j / ArrowDown → next hunk; k / ArrowUp → previous hunk.
 *
 * Dismissal paths — all three converge on `useCompareStore.closeCompare`:
 *   1. Escape key (local binding, stopPropagation to keep banner close from
 *      running right after).
 *   2. Click on the backdrop (mousedown target === backdrop root).
 *   3. Close button in the header.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useCompareStore } from '../../entities/compare/index.js';
import { useBlockStore, type Block } from '../../entities/block/index.js';
import { compareBlocks, type CompareView } from '../../features/compare/index.js';
import { computeHunks, type DiffLine, type DiffHunk } from '../../shared/lib/diff/index.js';
// FIXME(p1-block-ux): AnsiParser usage deferred until flag.blockUx lands in Epic δ.
// ComparePanel renders block-diff hunks with per-line ANSI styling; this is
// the last widget that still drives a parser directly. Carved out of
// `check-one-render-path` via the P1_BLOCK_UX_DEFERRED allowlist group
// (warning, not error) until the block UX flag migration.
import { AnsiParser } from '../../shared/lib/ansi-parser/index.js';
import { AnsiOutput, type AnsiSpan } from '../../shared/ui/ansi-output/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import styles from './compare-panel.module.css';

/** Viewport width below which we collapse to the unified single-column view. */
const UNIFIED_BREAKPOINT_PX = 900;

const TEXT_ENCODER = /* @__PURE__ */ new TextEncoder();

export interface ComparePanelProps {
  /**
   * Optional override — when set, use this comparator instead of the default
   * `compareBlocks`. Tests use this to inject deterministic views without
   * standing up two blocks in the store. Production leaves it unset.
   */
  readonly comparator?: (left: Block, right: Block) => CompareView;
}

export function ComparePanel(props: ComparePanelProps) {
  const open = useCompareStore((s) => s.open);
  const leftId = useCompareStore((s) => s.leftId);
  const rightId = useCompareStore((s) => s.rightId);
  const close = useCompareStore((s) => s.closeCompare);

  // Pull the two blocks via the full store — we need the streaming state
  // (output chunks) at the moment the panel opened. Using getState is fine
  // because the panel lives behind a modal gate; a subsequent stream
  // update to one of the blocks re-renders via the subscription below.
  const leftBlock = useBlockStore((s) => (leftId ? s.entities[leftId] : undefined));
  const rightBlock = useBlockStore((s) => (rightId ? s.entities[rightId] : undefined));

  if (!open) return null;
  if (!leftBlock || !rightBlock) {
    // Defensive: the feature dispatcher guards presence, but a clearHistory
    // between open and render could drop one side. Render nothing and quietly
    // close on the next tick so the overlay doesn't pin stale ids open.
    return <ComparePanelInvalid onClose={close} />;
  }

  return (
    <ComparePanelMounted
      leftBlock={leftBlock}
      rightBlock={rightBlock}
      onClose={close}
      {...(props.comparator ? { comparator: props.comparator } : {})}
    />
  );
}

ComparePanel.displayName = 'ComparePanel';

function ComparePanelInvalid(props: { readonly onClose: () => void }) {
  const { onClose } = props;
  // Depend on the destructured handler (stable per store subscription) rather
  // than the props object, which mints a new identity every render and would
  // re-fire the close effect indefinitely. Zustand's `closeCompare` action is
  // referentially stable across renders, so this settles on the first tick.
  useEffect(() => {
    onClose();
  }, [onClose]);
  return null;
}

interface MountedProps {
  readonly leftBlock: Block;
  readonly rightBlock: Block;
  readonly onClose: () => void;
  readonly comparator?: (left: Block, right: Block) => CompareView;
}

function ComparePanelMounted(props: MountedProps) {
  const { leftBlock, rightBlock, onClose, comparator = compareBlocks } = props;

  const view = useMemo(
    () => comparator(leftBlock, rightBlock),
    [comparator, leftBlock, rightBlock],
  );

  const hunks = useMemo(() => computeHunks(view.diff.lines), [view.diff.lines]);

  const [activeHunk, setActiveHunk] = useState(-1);
  useEffect(() => {
    // Reset hunk pointer when the underlying diff changes.
    setActiveHunk(-1);
  }, [view.diff]);

  // Viewport width breakpoint → unified vs side-by-side. We read once on
  // mount and on resize; SSR-safe fallback is wide.
  const [layout, setLayout] = useState<'side' | 'unified'>(() => {
    if (typeof window === 'undefined') return 'side';
    return window.innerWidth < UNIFIED_BREAKPOINT_PX ? 'unified' : 'side';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setLayout(window.innerWidth < UNIFIED_BREAKPOINT_PX ? 'unified' : 'side');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Focus the dialog on mount so Escape/j/k work without an extra click.
    dialogRef.current?.focus();
  }, []);

  const handleBackdropMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const jumpToHunk = useCallback(
    (idx: number) => {
      if (hunks.length === 0) return;
      const clamped = ((idx % hunks.length) + hunks.length) % hunks.length;
      setActiveHunk(clamped);
      const hunk = hunks[clamped];
      if (!hunk) return;
      const row = dialogRef.current?.querySelector(
        `[data-diff-row="${hunk.start}"]`,
      );
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    },
    [hunks],
  );

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        // Stop propagation so the global TerminalPage Escape handler doesn't
        // ALSO try to dismiss a banner in the same keystroke. The global
        // handler is skipped at the page by the `open` gate, but in strict
        // mode the order is determined by subscription time; stopping here
        // belts-and-braces the cascade.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        jumpToHunk(activeHunk + 1);
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        jumpToHunk(activeHunk - 1);
        return;
      }
    },
    [activeHunk, jumpToHunk, onClose],
  );

  const headerChips = useMemo(() => describeChips(view), [view]);

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
      data-testid="compare-panel-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('comparePanel.dialogLabel')}
        className={styles.panel}
        tabIndex={-1}
        onKeyDown={handleKey}
        data-layout={layout}
      >
        <header className={styles.header}>
          <span className={styles.title}>{t('comparePanel.title')}</span>
          <div className={styles.chips} role="group" aria-label={t('comparePanel.deltaGroupLabel')}>
            {headerChips.map((chip) => (
              <span
                key={chip.key}
                className={styles.chip}
                data-tone={chip.tone}
                title={chip.tooltip ?? chip.text}
              >
                <span className={styles.chipLabel}>{chip.label}</span>
                <span>{chip.text}</span>
              </span>
            ))}
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('comparePanel.closeLabel')}
          >
            {t('comparePanel.close')} <Kbd>Esc</Kbd>
          </button>
        </header>
        {view.diff.didTruncate ? (
          <div className={styles.truncatedBanner} role="status">
            {t('comparePanel.truncated')}
          </div>
        ) : null}
        <div className={styles.body} data-testid="compare-panel-body">
          {layout === 'side' ? (
            <SideBySideDiff view={view} activeHunk={activeHunk} hunks={hunks} />
          ) : (
            <UnifiedDiff view={view} activeHunk={activeHunk} hunks={hunks} />
          )}
        </div>
        <footer className={styles.footer}>
          <span className={styles.footerHint}>
            <Kbd>j</Kbd>/<Kbd>k</Kbd> {t('comparePanel.nextPrevHunk')}
          </span>
          <span className={styles.footerHint}>
            {hunks.length}{' '}
            {hunks.length === 1
              ? t('comparePanel.hunkSingular')
              : t('comparePanel.hunkPlural')}
          </span>
        </footer>
      </div>
    </div>
  );
}

interface DiffSubProps {
  readonly view: CompareView;
  readonly activeHunk: number;
  readonly hunks: readonly DiffHunk[];
}

const SideBySideDiff = memo(function SideBySideDiffImpl(props: DiffSubProps) {
  const { view, activeHunk, hunks } = props;
  const rows = view.diff.lines;
  const activeRange = hunks[activeHunk];

  // For side-by-side, each diff row renders in BOTH columns; a `+` row has a
  // placeholder on the left and real content on the right (and vice versa).
  // `' '` rows show the same text on both sides.
  return (
    <div
      className={styles.sideBySide}
      data-testid="compare-panel-side-by-side"
      data-active-hunk={String(activeHunk)}
    >
      <div className={styles.column}>
        <div className={styles.columnHeader}>
          <span>{t('comparePanel.previousRun')}</span>
          <span>{view.left.command}</span>
        </div>
        {rows.map((row, i) => {
          const inActive =
            activeRange !== undefined && i >= activeRange.start && i < activeRange.end;
          const leftRaw = row.leftIdx !== undefined ? view.leftRawLines[row.leftIdx] : undefined;
          return (
            <DiffColumnCell
              key={`L-${i}`}
              row={row}
              index={i}
              side="left"
              rawLine={leftRaw}
              isActive={inActive}
              {...(row.kind === '+' ? { placeholderKind: '+' as const } : {})}
            />
          );
        })}
      </div>
      <div className={styles.column}>
        <div className={styles.columnHeader}>
          <span>{t('comparePanel.newRun')}</span>
          <span>{view.right.command}</span>
        </div>
        {rows.map((row, i) => {
          const inActive =
            activeRange !== undefined && i >= activeRange.start && i < activeRange.end;
          const rightRaw = row.rightIdx !== undefined ? view.rightRawLines[row.rightIdx] : undefined;
          return (
            <DiffColumnCell
              key={`R-${i}`}
              row={row}
              index={i}
              side="right"
              rawLine={rightRaw}
              isActive={inActive}
              {...(row.kind === '-' ? { placeholderKind: '-' as const } : {})}
            />
          );
        })}
      </div>
    </div>
  );
});

const UnifiedDiff = memo(function UnifiedDiffImpl(props: DiffSubProps) {
  const { view, activeHunk, hunks } = props;
  const rows = view.diff.lines;
  const activeRange = hunks[activeHunk];

  return (
    <div className={styles.unified} data-testid="compare-panel-unified">
      {rows.map((row, i) => {
        const inActive =
          activeRange !== undefined && i >= activeRange.start && i < activeRange.end;
        const rawLine =
          row.kind === '+'
            ? row.rightIdx !== undefined
              ? view.rightRawLines[row.rightIdx]
              : undefined
            : row.leftIdx !== undefined
              ? view.leftRawLines[row.leftIdx]
              : row.rightIdx !== undefined
                ? view.rightRawLines[row.rightIdx]
                : undefined;
        return (
          <DiffColumnCell
            key={`U-${i}`}
            row={row}
            index={i}
            side="unified"
            rawLine={rawLine}
            isActive={inActive}
          />
        );
      })}
    </div>
  );
});

interface DiffColumnCellProps {
  readonly row: DiffLine;
  readonly index: number;
  readonly side: 'left' | 'right' | 'unified';
  readonly rawLine: string | undefined;
  readonly placeholderKind?: '+' | '-';
  readonly isActive: boolean;
}

const DiffColumnCell = memo(function DiffColumnCellImpl(props: DiffColumnCellProps) {
  const { row, index, side, rawLine, placeholderKind, isActive } = props;

  // Side-by-side: if this column has no real text for the given row, show a
  // visual placeholder (gutter showing the opposite-side marker, body empty).
  const isPlaceholder = side !== 'unified' && rawLine === undefined && placeholderKind !== undefined;

  const spans: readonly AnsiSpan[] = useMemo(() => {
    if (rawLine === undefined || rawLine.length === 0) return EMPTY_SPANS;
    // Render each diff line as a tiny one-shot ANSI parse. Colors are
    // preserved; everything else (CSI cursor moves, OSC links) is still
    // handled by the shared parser. A fresh parser per line is fine — the
    // state only needs to live for the length of one row, and the decoder
    // is cheap to construct.
    const parser = new AnsiParser();
    const bytes = TEXT_ENCODER.encode(rawLine);
    const out = parser.feed(bytes);
    const tail = parser.flush();
    if (tail.length === 0) return out;
    if (out.length === 0) return tail;
    return [...out, ...tail];
  }, [rawLine]);

  const rowKind = row.kind;
  const rowStyle: CSSProperties | undefined = isActive ? { zIndex: 1 } : undefined;

  return (
    <div
      className={cx(styles.row, isActive && styles.rowActive)}
      data-kind={rowKind}
      data-placeholder={isPlaceholder ? 'true' : 'false'}
      data-diff-row={String(index)}
      style={rowStyle}
    >
      <span className={styles.gutter}>
        {isPlaceholder ? placeholderKind : rowKind === ' ' ? '\u00a0' : rowKind}
      </span>
      <span className={styles.lineText}>
        {isPlaceholder ? (
          <span className={styles.placeholderText}>{/* empty */}</span>
        ) : spans.length === 0 ? (
          <span>&nbsp;</span>
        ) : (
          <AnsiOutput spans={spans} />
        )}
      </span>
    </div>
  );
});

const EMPTY_SPANS: readonly AnsiSpan[] = [];

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly tone: 'positive' | 'negative' | 'warning' | 'neutral';
  readonly tooltip?: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function formatSignedMs(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '±';
  return `${sign}${formatMs(Math.abs(ms))}`;
}

function formatSignedBytes(bytes: number): string {
  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '±';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${abs}B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)}MB`;
}

function describeChips(view: CompareView): Chip[] {
  const chips: Chip[] = [];
  if (view.deltas.commandsDiffer) {
    chips.push({
      key: 'cmd',
      label: 'command',
      text: 'different commands',
      tone: 'warning',
      tooltip: `${view.left.command} → ${view.right.command}`,
    });
  } else {
    chips.push({
      key: 'cmd',
      label: 'command',
      text: view.left.command,
      tone: 'neutral',
    });
  }

  const durTone: Chip['tone'] =
    view.deltas.durationDeltaMs > 0
      ? 'negative'
      : view.deltas.durationDeltaMs < 0
        ? 'positive'
        : 'neutral';
  chips.push({
    key: 'dur',
    label: 'duration',
    text: formatSignedMs(view.deltas.durationDeltaMs),
    tone: durTone,
    tooltip: `${formatMs(view.deltas.leftDurationMs)} → ${formatMs(view.deltas.rightDurationMs)}`,
  });

  const leftExit = view.deltas.leftExitCode;
  const rightExit = view.deltas.rightExitCode;
  const exitText =
    leftExit === rightExit
      ? `exit ${leftExit ?? '–'}`
      : `${leftExit ?? '–'} → ${rightExit ?? '–'}`;
  const exitTone: Chip['tone'] =
    rightExit === null
      ? 'neutral'
      : leftExit === rightExit
        ? rightExit === 0
          ? 'positive'
          : 'negative'
        : rightExit === 0
          ? 'positive'
          : 'negative';
  chips.push({
    key: 'exit',
    label: 'exit',
    text: exitText,
    tone: exitTone,
  });

  const bytesTone: Chip['tone'] =
    view.deltas.bytesDeltaBytes > 0
      ? 'warning'
      : view.deltas.bytesDeltaBytes < 0
        ? 'positive'
        : 'neutral';
  chips.push({
    key: 'bytes',
    label: 'bytes',
    text: formatSignedBytes(view.deltas.bytesDeltaBytes),
    tone: bytesTone,
    tooltip: `${view.deltas.leftBytes}B → ${view.deltas.rightBytes}B`,
  });

  return chips;
}
