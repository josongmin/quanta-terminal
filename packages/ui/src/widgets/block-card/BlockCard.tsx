/**
 * BlockCard — renders one command block as a Warp-style card.
 *
 * Composition:
 *   - Header: status dot, command text (truncated + tooltip if overflow),
 *     duration, exit code (when done), cwd badge, collapse caret, pin /
 *     copy / rerun icon buttons.
 *   - Body (expanded): monospace <pre> with decoded output bytes fed through
 *     the ANSI parser and rendered via `AnsiOutput`.
 *   - Body (collapsed): one-line peek of the last visible line plus a byte
 *     count. No output scroll area, padding is reduced.
 *
 * Subscription split (perf critical)
 * ----------------------------------
 * `appendBlockOutput` replaces a block's `outputChunks` array reference on
 * every streamed chunk, which — without this split — would cascade through
 * the entire card (re-running the header memos for duration, badges, the
 * action buttons, etc.). We subscribe to two specialized selectors:
 *
 *   - `useBlockHeader(id)` in `BlockCard`            — chrome only.
 *   - `useBlockOutputChunks(id)` in `BlockBody`      — bytes + status.
 *
 * A stream tick only invalidates the Body subtree; the header never
 * re-renders until a header-relevant field changes (status, collapse, pin,
 * exit code, errorMessage, completedAt).
 *
 * Click targets:
 *   - Clicking the header anywhere except the action buttons toggles
 *     collapse. This is what users expect from Warp-like surfaces.
 *   - All action buttons call stopPropagation to keep the toggle predictable.
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
  type RefObject,
} from 'react';
import { Badge } from '../../shared/ui/badge/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { Tooltip } from '../../shared/ui/tooltip/index.js';
import { Spinner } from '../../shared/ui/spinner/index.js';
import {
  AnsiOutput,
  applyControlChars,
  type AnsiSpan,
  type PathClickPayload,
  type SearchHighlights,
  type UrlClickPayload,
} from '../../shared/ui/ansi-output/index.js';
import { openExternalUrl as openExternalUrlAction } from '../../features/open-url/index.js';
import { AnsiParser, stripAnsi } from '../../shared/lib/ansi-parser/index.js';
import {
  distributeRangesToSpans,
  useBlockOutputMatches,
} from '../../features/output-search/index.js';
import {
  detectSecrets,
  useBlockRevealed,
  useSecretRedactSettings,
  useSecretRevealStore,
  type SecretMatch,
} from '../../features/secret-detect/index.js';
import {
  useBlockHeader,
  useBlockOutputChunks,
  useBlockStore,
  useBlockSuccessor,
  type Block,
  type BlockHeaderView,
  type BlockStatus,
  type BlockStreamView,
} from '../../entities/block/index.js';
import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import {
  openInEditor,
  openInEditorMessageForReason,
  type OpenInEditorResult,
} from '../../features/navigation/index.js';
import { exportBlockAs, type ExportFormat } from '../../features/block/export.js';
import {
  computeBlockSelectionRange,
  copyBlockAsMarkdown,
} from '../../features/block/copy-as-markdown.js';
import { cx } from '../../shared/lib/cx.js';
import { formatShortcutHint, subscribeKeymap } from '../../shared/lib/keymap.js';
import { createLogger } from '../../shared/lib/logger.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { showToast } from '../../shared/ui/toast/index.js';
import { t } from '../../shared/i18n/index.js';
import { BlockHoverCard } from './BlockHoverCard.js';
import { BlockTagStrip } from './BlockTagStrip.js';
import { CommandCorrectionHint } from '../../features/command-correction/index.js';
import { AiExplainPanel, useExplainShortcut } from '../../features/ai-explain/index.js';
import { useHighlighted } from '../../features/shell-highlight/index.js';
import styles from './block-card.module.css';

const log = createLogger('widgets/block-card');

export interface BlockCardProps {
  readonly block: Block;
  readonly onRerun?: (blockId: string) => void;
  readonly onCopy?: (blockId: string, scope: 'command' | 'output') => void;
  /**
   * Phase 4 — opens the Compare panel against this block's rerun pair. The
   * card gates the button on whether the block has a predecessor (rerunOfId
   * set) OR a successor (a later block whose rerunOfId points at this id).
   * When neither exists, the button is rendered in a disabled, grayed state
   * with a tooltip explaining why rather than removed — keeping the action
   * surface stable across reruns.
   */
  readonly onCompare?: (blockId: string) => void;
  /**
   * Command-correction hook. Invoked when the user clicks "Rerun with this"
   * on the `<CommandCorrectionHint />` rendered below a failed block
   * (exit 127). The callback receives the original failing block id plus
   * the corrected command text — the host is responsible for submitting it
   * through the composer (or whatever equivalent pathway it uses).
   *
   * When omitted, the hint still renders but its rerun button becomes a
   * no-op. The dismiss button keeps working.
   */
  readonly onRerunWithCorrection?: (blockId: string, correctedCommand: string) => void;
}

// Collapsed peek shows a single line of output as plain text. We decode the
// bytes with TextDecoder AND pass the result through `stripAnsi` so raw ESC
// sequences (e.g. zsh's PROMPT_EOL_MARK `\e[1m\e[7m%\e[0m`) don't render as
// literal tofu glyphs in the peek row. Module-scoped to avoid allocating per
// card. Full ANSI rendering in the expanded body still goes through
// `AnsiParser`; this path is only for the one-liner summary.
const TEXT_DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

// Shared empty chunks sentinel — lets the body render safely when the store
// has no entry for the id (e.g. after clearHistory mid-animation) without
// allocating a fresh [] on every render.
const EMPTY_CHUNKS: readonly Uint8Array[] = [];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function totalBytes(chunks: readonly Uint8Array[]): number {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  return n;
}

function lastLine(text: string): string {
  if (text.length === 0) return '';
  // Ignore a single trailing newline: programs conventionally end with one
  // and the user wants to see the last *meaningful* line in the peek.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const i = trimmed.lastIndexOf('\n');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/**
 * Audit P1 (fix 7): count visible lines across a list of raw byte chunks.
 * Cheaper than decoding+splitting because we only count newline bytes (0x0A).
 * An output that ends without a trailing newline still counts its last line,
 * so a one-line echo shows "1 line", not "0 lines".
 */
function countLines(chunks: readonly Uint8Array[]): number {
  let newlines = 0;
  let anyBytes = false;
  let endsWithNewline = false;
  for (const chunk of chunks) {
    if (chunk.byteLength === 0) continue;
    anyBytes = true;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] === 0x0a) newlines += 1;
    }
    endsWithNewline = chunk[chunk.byteLength - 1] === 0x0a;
  }
  if (!anyBytes) return 0;
  return endsWithNewline ? newlines : newlines + 1;
}

function BlockCardImpl(props: BlockCardProps) {
  const { block, onRerun, onCopy, onCompare, onRerunWithCorrection } = props;
  // Subscribe to the chrome view, falling back to the incoming prop on the
  // first render (the store is the source of truth thereafter). `block` is
  // still the entry used by callers that hand-construct a card in isolation
  // (tests, storybook).
  const storeHeader = useBlockHeader(block.id);
  const header: BlockHeaderView = storeHeader ?? toHeaderView(block);

  const commandSpans = useHighlighted({ value: header.command, styles });

  // EPIC-H §4.2: alt-screen chrome collapse. When an alt-screen program is
  // running and THIS card is the owning block's chrome (status === 'running'
  // and our session matches the tui store's sessionId), the chrome fades
  // out to a thin status line via CSS. Non-running cards are unaffected.
  const altScreen = useAltScreenMode();
  const tuiSessionId = useTuiStore((s) => s.sessionId);
  const isOwningAltScreenBlock =
    header.status === 'running' &&
    altScreen.active &&
    (tuiSessionId === null || tuiSessionId === header.sessionId);

  const toggleCollapse = useBlockStore((s) => s.toggleCollapse);
  const togglePin = useBlockStore((s) => s.togglePin);

  // Compare button gate — true when the block has a predecessor OR a
  // successor. Previously this scanned `s.order` from every card on every
  // store mutation (O(cards × blocks)); now backed by the store-maintained
  // `rerunChildByParent` index for a single-map-read lookup.
  const successor = useBlockSuccessor(block.id);
  const hasSuccessor = successor !== undefined;
  const canCompare = header.rerunOfId !== null || hasSuccessor;

  const duration = useMemo(() => {
    const end = header.completedAt ?? Date.now();
    return formatDuration(Math.max(0, end - header.startedAt));
  }, [header.startedAt, header.completedAt]);

  const handleHeaderClick = useCallback(() => {
    toggleCollapse(header.id);
  }, [header.id, toggleCollapse]);

  const handleHeaderKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCollapse(header.id);
      }
    },
    [header.id, toggleCollapse],
  );

  const stop = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
  }, []);

  const onPinClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      togglePin(header.id);
    },
    [header.id, stop, togglePin],
  );

  const onCopyClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      // TODO(menu): show a two-item menu for command vs output. Phase 2 ships
      // "copy output" as the primary action since that's what users want most
      // when reviewing a finished block.
      onCopy?.(header.id, 'output');
    },
    [header.id, onCopy, stop],
  );

  const onRerunClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      onRerun?.(header.id);
    },
    [header.id, onRerun, stop],
  );

  // Ref to the `<article>` root — also used by the tag editor shortcut hook
  // further down. Declared up here so the copy-as-markdown handler (which
  // scopes `window.getSelection()` to this card) can reference it too.
  const articleRef = useRef<HTMLElement | null>(null);

  // Export menu state — a tiny local dropdown. Opens on button click, closes
  // on selection / outside click / Escape.
  const [exportOpen, setExportOpen] = useState(false);
  const exportWrapRef = useRef<HTMLSpanElement | null>(null);

  // Rich hover card state. The card is shown after a short dwell (500 ms)
  // to match the ambient tooltip cadence — any shorter flickers across a
  // scroll gesture. `hoverPos` is the anchor we pass to the portaled card
  // (centered above the header); measured on show and on each mouse move
  // so the card tracks trailing hovers during slow drags. The card is
  // positioned relative to the *header* (not the whole card) because the
  // expanded body can be tall and we don't want the tooltip above a 40-row
  // output pre.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const measureHoverAnchor = useCallback(() => {
    const el = headerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHoverPos({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  const handleHeaderEnter = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    // 500 ms dwell matches the base Tooltip's "show after pause" feel and
    // keeps the card from popping mid-mouse-travel. Cleared on leave below.
    hoverTimerRef.current = window.setTimeout(() => {
      measureHoverAnchor();
      setHoverOpen(true);
    }, 500);
  }, [measureHoverAnchor]);

  const handleHeaderLeave = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverOpen(false);
  }, []);

  // Close the hover card on unmount so a stale timer can't fire into an
  // unmounted tree.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  // While the card is open, re-measure on scroll / resize so it tracks the
  // block through virtualized scroll. Mirrors the base Tooltip's anchor
  // strategy.
  useEffect(() => {
    if (!hoverOpen) return;
    const onScroll = () => measureHoverAnchor();
    const onResize = () => measureHoverAnchor();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [hoverOpen, measureHoverAnchor]);
  useEffect(() => {
    if (!exportOpen) return;
    const onDocClick = (ev: globalThis.MouseEvent) => {
      const wrap = exportWrapRef.current;
      if (!wrap) return;
      if (ev.target instanceof Node && wrap.contains(ev.target)) return;
      setExportOpen(false);
    };
    const onDocKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [exportOpen]);

  const onExportToggle = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      setExportOpen((v) => !v);
    },
    [stop],
  );

  const runExport = useCallback(
    async (format: ExportFormat) => {
      setExportOpen(false);
      const text = exportBlockAs(header.id, format);
      if (text === null) {
        showToast({
          kind: 'warning',
          message: t('blockCard.export.toastFailed', { reason: 'not-found' }),
        });
        return;
      }
      const clipboard =
        typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        showToast({
          kind: 'warning',
          message: t('blockCard.export.toastFailed', { reason: 'no-clipboard' }),
        });
        return;
      }
      try {
        await clipboard.writeText(text);
        const key =
          format === 'markdown'
            ? 'blockCard.export.toastMarkdown'
            : format === 'json'
              ? 'blockCard.export.toastJson'
              : 'blockCard.export.toastText';
        showToast({ kind: 'info', message: t(key) });
      } catch (err) {
        log.warn('export clipboard write failed', err);
        showToast({
          kind: 'warning',
          message: t('blockCard.export.toastFailed', { reason: 'write-failed' }),
        });
      }
    },
    [header.id],
  );

  const onExportMarkdown = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      void runExport('markdown');
    },
    [runExport, stop],
  );

  // "Copy as Markdown" — selection-aware. Reads the live `window.getSelection()`
  // scoped to this card's article root; a collapsed / outside-article selection
  // falls through to the full block. Closes the export menu first so clicking
  // the menu item feels decisive.
  const copyAsMarkdown = useCallback(async () => {
    setExportOpen(false);
    const root = articleRef.current;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const range = computeBlockSelectionRange(root, sel);
    const result = await copyBlockAsMarkdown({
      blockId: header.id,
      selection: range,
    });
    if (result.ok) {
      showToast({
        kind: 'info',
        message: t(
          range === null
            ? 'blockCard.copyAsMarkdown.toastFull'
            : 'blockCard.copyAsMarkdown.toastSelection',
        ),
      });
      return;
    }
    log.warn('copy-as-markdown failed', result.reason, result.error?.message);
    showToast({
      kind: 'warning',
      message: t('blockCard.copyAsMarkdown.toastFailed', { reason: result.reason }),
    });
  }, [header.id]);

  const onCopyAsMarkdownClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      void copyAsMarkdown();
    },
    [copyAsMarkdown, stop],
  );

  // Register keyboard shortcut + palette event listener scoped to "this card
  // owns focus". Mirrors `useBlockTagEditorShortcut`'s pattern so the two
  // focused-card entry points stay consistent.
  useBlockCopyAsMarkdownShortcut(articleRef, copyAsMarkdown);
  const onExportJson = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      void runExport('json');
    },
    [runExport, stop],
  );
  const onExportText = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      void runExport('text');
    },
    [runExport, stop],
  );

  const onCompareClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      if (!canCompare) return;
      onCompare?.(header.id);
    },
    [canCompare, header.id, onCompare, stop],
  );

  // Stop button (ADR 0004 CancelBlock RPC): dispatches a fire-and-forget
  // cancel through the host bridge. The UI does not await the host's reply
  // beyond logging — the canceled state arrives back via the normal event
  // stream (sidecar emits BlockCompleted with reason=canceled → pty_exit →
  // command router finalizes the block). Double-clicks are idempotent at
  // the bridge layer so we don't gate the button on a sending-spinner.
  const onStopClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      stop(e);
      const bridge = tryGetHostBridge();
      if (!bridge) {
        log.debug('stop clicked but no bridge installed');
        return;
      }
      // Fire-and-forget: the button returns immediately so the click never
      // blocks the UI. Errors are logged; the sidecar command swallows the
      // idempotent "already-terminated" case so a stale click is a no-op.
      void bridge.cancelBlock(header.sessionId, header.id).catch((err: unknown) => {
        log.warn('cancelBlock rejected', err);
      });
    },
    [header.id, header.sessionId, stop],
  );

  const exitAttr = header.exitCode === null ? undefined : header.exitCode === 0 ? '0' : 'nonzero';

  // Tag-editor open signal — monotonic counter bumped by the `T` shortcut
  // (wired via `useBlockTagEditorShortcut` below). BlockTagStrip opens its
  // popover whenever this increments; we start at 0 so the initial render
  // stays closed.
  const [tagOpenSignal, setTagOpenSignal] = useState(0);
  useBlockTagEditorShortcut(articleRef, () => setTagOpenSignal((v) => v + 1));

  // "Explain this error" shortcut — `E` while this card has focus fires a
  // window event the `<AiExplainPanel />` below listens for. The hook
  // gates on the exit code / feature flag internally, so binding it
  // unconditionally here is free (no side effects for a succeeding block).
  useExplainShortcut({ articleRef, blockId: header.id });

  return (
    <article
      ref={articleRef}
      className={cx(
        styles.card,
        isOwningAltScreenBlock ? styles.altScreenCollapsed : undefined,
        altScreen.crashed && isOwningAltScreenBlock ? styles.altScreenCrashed : undefined,
      )}
      data-testid={`block-card-${header.id}`}
      data-status={header.status}
      data-collapsed={header.collapsed ? 'true' : 'false'}
      data-alt-screen={isOwningAltScreenBlock ? 'true' : 'false'}
      data-alt-depth={String(altScreen.depth)}
    >
      <span className={styles.stripe} aria-hidden />
      <div
        ref={headerRef}
        className={styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={!header.collapsed}
        aria-label={`Block: ${header.command}`}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKey}
        onMouseEnter={handleHeaderEnter}
        onMouseLeave={handleHeaderLeave}
        onFocus={handleHeaderEnter}
        onBlur={handleHeaderLeave}
      >
        {header.status === 'running' ? (
          <Spinner size="sm" label="Running" />
        ) : (
          <span
            className={styles.dot}
            aria-hidden
            {...(exitAttr !== undefined ? { 'data-exit': exitAttr } : {})}
          />
        )}
        <Tooltip content={header.command}>
          <span className={styles.command}>
            {commandSpans.length > 0
              ? commandSpans.map((s, i) =>
                  s.className !== null
                    ? <span key={i} className={s.className}>{s.text}</span>
                    : <span key={i}>{s.text}</span>
                )
              : header.command}
          </span>
        </Tooltip>
        <span className={styles.meta}>
          <span className={styles.duration} aria-label="Duration">
            {duration}
          </span>
          {header.exitCode !== null && (
            <span
              className={styles.exit}
              data-nonzero={header.exitCode !== 0 ? 'true' : 'false'}
              aria-label={`Exit code ${header.exitCode}`}
            >
              exit {header.exitCode}
            </span>
          )}
          {header.cwd && (
            <Badge
              label={header.cwd}
              tone="neutral"
              srDescription={`Working directory ${header.cwd}`}
            />
          )}
        </span>
        <span
          className={styles.actions}
          data-alt-collapsed={isOwningAltScreenBlock ? 'true' : 'false'}
        >
          {header.status === 'running' && (
            <Tooltip content={<>Stop</>}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={onStopClick}
                aria-label="Stop running block"
                data-testid={`block-card-stop-${header.id}`}
              >
                <StopIcon />
              </button>
            </Tooltip>
          )}
          {/* EPIC-H §4.2: during alt-screen the pin / rerun / compare buttons
             are hidden; copy remains available. */}
          {!isOwningAltScreenBlock && (
            <Tooltip
              content={
                <>
                  {header.pinned ? 'Unpin' : 'Pin'} <Kbd>P</Kbd>
                </>
              }
            >
              <button
                type="button"
                className={styles.iconButton}
                onClick={onPinClick}
                aria-label={header.pinned ? 'Unpin block' : 'Pin block'}
                data-active={header.pinned ? 'true' : 'false'}
              >
                <PinIcon />
              </button>
            </Tooltip>
          )}
          <Tooltip
            content={
              <>
                Copy output <Kbd>{formatShortcutHint('mod+c')}</Kbd>
              </>
            }
          >
            <button
              type="button"
              className={styles.iconButton}
              onClick={onCopyClick}
              aria-label="Copy block output"
              data-testid={`block-card-copy-${header.id}`}
            >
              <CopyIcon />
            </button>
          </Tooltip>
          <span className={styles.exportWrap} ref={exportWrapRef}>
            <Tooltip content={<>{t('blockCard.export.tooltip')}</>}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={onExportToggle}
                aria-label={t('blockCard.export.menuLabel')}
                aria-haspopup="menu"
                aria-expanded={exportOpen ? 'true' : 'false'}
                data-testid={`block-card-export-${header.id}`}
              >
                <ExportIcon />
              </button>
            </Tooltip>
            {exportOpen && (
              <div
                role="menu"
                aria-label={t('blockCard.export.menuLabel')}
                className={styles.exportMenu}
                data-testid={`block-card-export-menu-${header.id}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={styles.exportMenuItem}
                  onClick={onCopyAsMarkdownClick}
                  data-testid={`block-card-copy-as-markdown-${header.id}`}
                  aria-label={t('blockCard.copyAsMarkdown.label')}
                >
                  {t('blockCard.copyAsMarkdown.label')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.exportMenuItem}
                  onClick={onExportMarkdown}
                  data-testid={`block-card-export-markdown-${header.id}`}
                >
                  {t('blockCard.export.markdown')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.exportMenuItem}
                  onClick={onExportJson}
                  data-testid={`block-card-export-json-${header.id}`}
                >
                  {t('blockCard.export.json')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.exportMenuItem}
                  onClick={onExportText}
                  data-testid={`block-card-export-text-${header.id}`}
                >
                  {t('blockCard.export.text')}
                </button>
              </div>
            )}
          </span>
          {!isOwningAltScreenBlock && (
            <Tooltip
              content={
                <>
                  Rerun <Kbd>{formatShortcutHint('mod+r')}</Kbd>
                </>
              }
            >
              <button
                type="button"
                className={styles.iconButton}
                onClick={onRerunClick}
                aria-label="Rerun command"
                data-testid={`block-card-rerun-${header.id}`}
              >
                <RerunIcon />
              </button>
            </Tooltip>
          )}
          {!isOwningAltScreenBlock && (
            <Tooltip
              content={canCompare ? <>Compare against previous run</> : <>No prior run to compare</>}
            >
              <button
                type="button"
                className={styles.iconButton}
                onClick={onCompareClick}
                aria-label={canCompare ? 'Compare against previous run' : 'Compare (no prior run)'}
                disabled={!canCompare}
                data-testid={`block-card-compare-${header.id}`}
                aria-disabled={!canCompare}
              >
                <CompareIcon />
              </button>
            </Tooltip>
          )}
          <span className={styles.caret} aria-hidden>
            <CaretIcon />
          </span>
        </span>
      </div>

      {!isOwningAltScreenBlock && (
        <BlockTagStrip blockId={header.id} tags={header.tags} openSignal={tagOpenSignal} />
      )}

      <BlockBody
        blockId={header.id}
        collapsed={header.collapsed}
        errorMessage={header.errorMessage}
        command={header.command}
        duration={duration}
        exitCode={header.exitCode}
        status={header.status}
      />

      {/*
        "Did you mean?" hint. Mounts below the body; the component itself
        short-circuits to `null` unless the block completed with exit 127 AND
        `suggestCorrection` produced a confident match. Rendering
        unconditionally keeps BlockCard free of correction logic — every
        decision lives in the feature slice.
      */}
      <CommandCorrectionHint
        blockId={header.id}
        onRerunWithCorrection={
          onRerunWithCorrection ??
          NOOP_CORRECTION_RERUN /* stable no-op so memoized hint doesn't churn */
        }
      />

      {/*
        AI "Explain this error" affordance. Internally gates on:
          - master `aiExplainEnabled` setting,
          - block being in a non-zero terminal state,
          - user not having dismissed it.
        Rendering unconditionally keeps BlockCard free of feature logic —
        every branch lives inside the panel.
      */}
      <AiExplainPanel blockId={header.id} />

      {hoverOpen && (
        <BlockHoverCard block={block} x={hoverPos.x} y={hoverPos.y} open={hoverOpen} />
      )}
    </article>
  );
}

/**
 * Stable no-op rerun handler — referenced when BlockCard's parent doesn't
 * wire `onRerunWithCorrection`. Declared at module scope so its identity is
 * stable across renders, preventing the memoized `CommandCorrectionHint`
 * from re-rendering on every parent update.
 */
const NOOP_CORRECTION_RERUN = (_blockId: string, _command: string): void => {
  /* intentionally empty */
};

/**
 * Memoized outer export. The chrome + body both re-subscribe to the store via
 * their own selectors (`useBlockHeader`, `useBlockOutputChunks`) so the card
 * does not need to re-run its function body when its `block` prop is refreshed
 * by a parent subscription that flipped identity on chunk append. The custom
 * comparator skips the re-render when the block id and the three optional
 * handlers are stable — subscriptions inside will still fire for any meaningful
 * header/body update.
 */
export const BlockCard = memo(BlockCardImpl, (prev, next) => {
  return (
    prev.block.id === next.block.id &&
    prev.onRerun === next.onRerun &&
    prev.onCopy === next.onCopy &&
    prev.onCompare === next.onCompare &&
    prev.onRerunWithCorrection === next.onRerunWithCorrection
  );
});

BlockCard.displayName = 'BlockCard';

function toHeaderView(b: Block): BlockHeaderView {
  return {
    id: b.id,
    sessionId: b.sessionId,
    command: b.command,
    status: b.status,
    cwd: b.cwd,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
    exitCode: b.exitCode,
    collapsed: b.collapsed,
    pinned: b.pinned,
    errorMessage: b.errorMessage,
    rerunOfId: b.rerunOfId,
    tags: b.tags,
  };
}

/**
 * Keyboard hook — when the card OR a descendant has focus AND the user
 * presses `T` (no modifiers, not inside a typing target), bump the tag
 * editor open signal. Implemented via the global `subscribeKeymap` with a
 * gating check against `articleRef.current?.contains(document.activeElement)`
 * so `T` only triggers for the card that owns focus. This keeps the binding
 * global (one listener) while the semantics stay per-card.
 */
function useBlockTagEditorShortcut(
  articleRef: RefObject<HTMLElement | null>,
  onOpen: () => void,
): void {
  useEffect(() => {
    const sub = subscribeKeymap({
      shortcut: 't',
      handler: () => {
        const article = articleRef.current;
        if (!article) return;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!active || !article.contains(active)) return;
        onOpen();
      },
      allowInEditable: false,
    });
    return () => sub.unsubscribe();
  }, [articleRef, onOpen]);

  // Command-palette "Tag active block…" entry dispatches a window event; the
  // card whose descendant holds focus responds by opening the editor. Using
  // the same focus-check as the keyboard shortcut keeps the two entry
  // points semantically identical.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenEvent = () => {
      const article = articleRef.current;
      if (!article) return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!active || !article.contains(active)) return;
      onOpen();
    };
    window.addEventListener('quanta:open-tag-editor', onOpenEvent);
    return () => window.removeEventListener('quanta:open-tag-editor', onOpenEvent);
  }, [articleRef, onOpen]);
}

/**
 * Keyboard hook — Cmd+Shift+C (Ctrl+Shift+C on non-macOS) when this card's
 * subtree owns focus triggers "Copy as Markdown". Mirrors the focus-gated
 * `useBlockTagEditorShortcut` pattern so the global keymap still owns the
 * single listener while the semantics stay per-card.
 *
 * Additionally listens for the `quanta:copy-block-as-markdown` window event
 * the command palette dispatches, so the palette entry and the shortcut
 * share one handler.
 */
function useBlockCopyAsMarkdownShortcut(
  articleRef: RefObject<HTMLElement | null>,
  onInvoke: () => void | Promise<void>,
): void {
  useEffect(() => {
    const sub = subscribeKeymap({
      shortcut: 'mod+shift+c',
      handler: (event) => {
        const article = articleRef.current;
        if (!article) return;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!active || !article.contains(active)) return;
        // The browser's default Cmd+Shift+C may be bound to DevTools or a
        // selection-copy variant — preventDefault so our action wins when
        // the card has focus.
        event.preventDefault();
        void onInvoke();
      },
      allowInEditable: false,
    });
    return () => sub.unsubscribe();
  }, [articleRef, onInvoke]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onEvent = () => {
      const article = articleRef.current;
      if (!article) return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!active || !article.contains(active)) return;
      void onInvoke();
    };
    window.addEventListener('quanta:copy-block-as-markdown', onEvent);
    return () => window.removeEventListener('quanta:copy-block-as-markdown', onEvent);
  }, [articleRef, onInvoke]);
}

/* ------------------------------- Body ---------------------------------- */

interface BlockBodyProps {
  readonly blockId: string;
  readonly collapsed: boolean;
  readonly errorMessage: string | null;
  /**
   * Audit P1 (fix 7): chrome bits forwarded from the header so the collapsed
   * summary row (`COMMAND · 42 lines · 1.2s · exit 0`) can render without a
   * second subscription. All four are cheap/stable; re-passing them on every
   * stream tick is free because the body re-renders on chunk append anyway.
   */
  readonly command: string;
  readonly duration: string;
  readonly exitCode: number | null;
  readonly status: BlockStatus;
}

/**
 * Identify a zsh/bash/tcsh `PROMPT_EOL_MARK` span — the reverse-video
 * single-char sigil (`%`, `#`, `$`, `>`) the shell emits when the last
 * command's stdout did not end in a newline. Removed from the expanded
 * body's span list because the UI already shows the command boundary
 * via a distinct block card; the sigil is noise there.
 *
 * The test is strict — single printable sigil char AND marked as
 * reverse-video (inverse SGR) — so a styled real `%` elsewhere (e.g. a
 * reverse-video highlight in a TUI) isn't caught by accident.
 */
function isPromptEolMarkSpan(span: AnsiSpan): boolean {
  const t = span.text ?? '';
  if (t.length !== 1) return false;
  if (t !== '%' && t !== '#' && t !== '$' && t !== '>') return false;
  return span.inverse === true;
}

/**
 * Preprocess spans for carriage-return sequences that cross PTY read boundaries.
 *
 * ZLE (zsh line editor) echoes each keystroke on a separate PTY read call, so
 * typing "ls" produces span1="l" then span2="\rls". A per-span CR rewrite only
 * resets within its own span, rendering "lls". This fold operates across the
 * full span list: a leading "\r" in span2 erases everything accumulated on the
 * current line (including span1's "l") before the new text is written.
 *
 * CRLF ("\r\n"): PTY cooked mode (ONLCR) emits "\r\n" as a standard line
 * ending. The "\r" must NOT erase the current line — it is the first half of a
 * newline sequence. We collapse "\r\n" → "\n" so downstream rendering never
 * sees bare "\r" followed by "\n" and inadvertently wipes file listings.
 */
function foldSpansWithCR(spans: readonly AnsiSpan[]): readonly AnsiSpan[] {
  if (!spans.some((s) => s.text.includes('\r'))) return spans;
  const result: AnsiSpan[] = [];
  const line: AnsiSpan[] = [];
  let pendingCR = false;
  let pendingCRSpan: AnsiSpan | null = null;

  const flushLine = (nlSpan: AnsiSpan): void => {
    result.push(...line);
    result.push({ ...nlSpan, text: '\n' });
    line.length = 0;
  };

  for (const span of spans) {
    const t = span.text;
    let segStart = 0;
    for (let i = 0; i <= t.length; i++) {
      const ch = i < t.length ? t[i] : null;
      // End-of-span: a trailing \r must defer its decision to the NEXT span's
      // first character (could be \n → CRLF, or anything else → standalone CR).
      // Processing pendingCR here with ch=null would incorrectly treat it as a
      // standalone CR and erase the current line (the ls-output-blank-output bug).
      if (ch === null) break;
      if (pendingCR) {
        pendingCR = false;
        if (ch === '\n') {
          // "\r\n" — collapse to a plain newline; do NOT erase the line.
          flushLine(pendingCRSpan!);
          pendingCRSpan = null;
          segStart = i + 1;
          continue;
        }
        // Standalone "\r" — erase everything on the current line.
        line.length = 0;
        pendingCRSpan = null;
      }
      if (ch === '\n') {
        if (i > segStart) line.push({ ...span, text: t.slice(segStart, i) });
        flushLine(span);
        segStart = i + 1;
      } else if (ch === '\r') {
        if (i > segStart) line.push({ ...span, text: t.slice(segStart, i) });
        pendingCR = true;
        pendingCRSpan = span;
        segStart = i + 1;
      }
    }
    if (segStart < t.length) line.push({ ...span, text: t.slice(segStart) });
  }
  // Trailing bare "\r": cursor moved to col 0 but nothing followed.
  // Root cause of intermittent blank output: zsh positions cursor before
  // the PROMPT_EOL_MARK sigil (`%`), which isPromptEolMarkSpan filters away.
  // With the sigil gone, this "\r" is the last span character and would erase
  // the final output line. Discard the pending CR but keep line content.
  result.push(...line);
  return result;
}

/**
 * Body subscribes to the *streaming* view only, so header-only mutations
 * (collapse, pin) do not roll back through this subtree. On each mutation
 * of `outputChunks` we incrementally feed NEW chunks to the parser and
 * PUSH emitted spans into a stable array in place — avoiding the O(n²)
 * "spread-and-replace" pattern that would allocate a fresh array per chunk.
 */
const BlockBody = memo(function BlockBodyImpl(props: BlockBodyProps) {
  const {
    blockId,
    collapsed,
    errorMessage,
    command,
    duration,
    exitCode,
    status: headerStatus,
  } = props;
  const stream: BlockStreamView | undefined = useBlockOutputChunks(blockId);

  // Stable spans array: the parser pushes into it in place. The cursor ref
  // remembers how many chunks have already been consumed so each render only
  // feeds what's new; the "drained" flag guards `flush()` so we don't
  // re-flush on subsequent renders after completion. These guards also make
  // the effect safe under React StrictMode's double-invoke.
  //
  // Shell-echo note: cooked-mode shells USED to echo our writes back to us,
  // which produced a duplicate-command line at the head of every block.
  // That is now cut off at the root in the PTY adapter
  // (`crates/quanta-pty/src/adapters/portable.rs::disable_echo_on_master`),
  // which clears `LocalFlags::ECHO*` on the master fd before spawn. No
  // echo ever reaches this component, so there's no need for an in-UI
  // `stripEchoPrefix` pass. The PROMPT_EOL_MARK filter below is a
  // different concern — zsh's "%" sigil for stdout-missing-newline —
  // and stays.
  const parserRef = useRef<AnsiParser | null>(null);
  const feedCursorRef = useRef(0);
  const spansRef = useRef<AnsiSpan[]>([]);
  const drainedRef = useRef(false);
  const [version, setVersion] = useState(0);

  const chunks = stream?.outputChunks ?? EMPTY_CHUNKS;
  const status = stream?.status ?? 'running';

  // Secret-detection wiring. We read the user's master "redact secrets in
  // output" preference and the per-block reveal flag; the actual detector
  // runs inside the spans memo below so we pay the regex cost only once
  // per render, not once per read.
  const redactEnabled = useSecretRedactSettings((s) => s.enabled);
  const blockRevealed = useBlockRevealed(blockId);
  const toggleReveal = useSecretRevealStore((s) => s.toggle);
  const onToggleSecrets = useCallback(() => {
    toggleReveal(blockId);
  }, [blockId, toggleReveal]);

  useEffect(() => {
    if (parserRef.current === null) {
      parserRef.current = new AnsiParser();
      feedCursorRef.current = 0;
      spansRef.current = [];
      drainedRef.current = false;
    }
    // Store reset (clearHistory) or block rerun: chunks regressed → rebuild.
    if (feedCursorRef.current > chunks.length) {
      parserRef.current.reset();
      feedCursorRef.current = 0;
      spansRef.current = [];
      drainedRef.current = false;
    }
    let appended = 0;
    for (let i = feedCursorRef.current; i < chunks.length; i += 1) {
      const next = chunks[i];
      if (!next) continue;
      const out = parserRef.current.feed(next);
      for (const s of out) {
        // Drop zsh's PROMPT_EOL_MARK sigil spans (reverse-video `%`/`#`/
        // `$`/`>`). The parser surfaces them as styled spans; we do not
        // want them in the block body because the block boundary itself
        // is the UX signal the sigil was meant to provide.
        if (isPromptEolMarkSpan(s)) continue;
        spansRef.current.push(s);
        appended += 1;
      }
    }
    feedCursorRef.current = chunks.length;

    if (status !== 'running' && drainedRef.current === false) {
      const tail = parserRef.current.flush();
      for (const s of tail) {
        if (isPromptEolMarkSpan(s)) continue;
        spansRef.current.push(s);
        appended += 1;
      }
      drainedRef.current = true;
    }

    if (appended > 0) setVersion((v) => v + 1);
  }, [chunks, status]);

  const bytes = useMemo(() => totalBytes(chunks), [chunks]);

  // Audit P1 (fix 7): cheap byte-level line count — exact to the byte without
  // decoding. Only materialized when collapsed since expanded mode shows the
  // real output.
  const lineCount = useMemo(() => (collapsed ? countLines(chunks) : 0), [collapsed, chunks]);

  const decodedForPeek = useMemo(() => {
    if (!collapsed) return '';
    if (chunks.length === 0) return '';
    // Tail-only decode (review F16): the peek only renders the LAST line
    // of output, so decoding the full history is wasted work — and for
    // commands that stream megabytes (e.g. `cat large.log`) it becomes a
    // per-render UI hang. Walk the chunks backward accumulating up to
    // `PEEK_TAIL_BYTES` of tail bytes, then decode that slice. UTF-8
    // boundary handling: TextDecoder with `fatal:false` emits U+FFFD for
    // an invalid leading byte and continues, so a mid-codepoint tail slice
    // at worst corrupts the very first character of the slice — and
    // `lastLine()` above discards everything before the final newline
    // anyway, so the visible peek is unaffected for any output whose
    // last line fits inside the window.
    const PEEK_TAIL_BYTES = 8192;
    let acc = 0;
    let startChunk = chunks.length;
    let startOffset = 0;
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const c = chunks[i]!;
      if (acc + c.byteLength >= PEEK_TAIL_BYTES) {
        startChunk = i;
        startOffset = c.byteLength - (PEEK_TAIL_BYTES - acc);
        acc = PEEK_TAIL_BYTES;
        break;
      }
      acc += c.byteLength;
      startChunk = i;
      startOffset = 0;
    }
    const tail = new Uint8Array(acc);
    let off = 0;
    for (let i = startChunk; i < chunks.length; i += 1) {
      const c = chunks[i]!;
      if (i === startChunk && startOffset > 0) {
        const sub = c.subarray(startOffset);
        tail.set(sub, off);
        off += sub.byteLength;
      } else {
        tail.set(c, off);
        off += c.byteLength;
      }
    }
    // Strip ANSI escapes so the peek line renders as readable plain text —
    // otherwise zsh's `PROMPT_EOL_MARK` bytes (`\e[1m\e[7m%\e[0m`) would
    // render as literal ESC glyphs in the one-line summary.
    //
    // CR rewrite: zsh ZLE emits `\r`-prefixed redraws on every keystroke
    // while the user is composing, so the naive byte stream is
    // `l\rls\r<output>` for `ls`. Collapsing `\r` to the start of the
    // current line the way a real terminal does turns that into just
    // `<output>` in the peek — same logic as the expanded body's
    // `carriageReturnRewrites` flag on `AnsiOutput`.
    const raw = stripAnsi(TEXT_DECODER.decode(tail));
    let out = '';
    let lineStart = 0;
    for (const ch of raw) {
      if (ch === '\n') {
        out += ch;
        lineStart = out.length;
      } else if (ch === '\r') {
        out = out.slice(0, lineStart);
      } else {
        out += ch;
      }
    }
    return out;
  }, [collapsed, chunks]);

  // Phase 3: click on a detected `path:line:col` in the output. We dispatch
  // through `features/navigation` which resolves relative paths against the
  // session cwd and then delegates to the host bridge.
  //
  // Audit P1 (fix 5): previously the failure path was log-only. Now we
  // surface a short-lived toast keyed by `reason` so the user gets feedback
  // when the editor isn't installed / the path is invalid / the bridge
  // didn't respond. Success stays silent.
  const onPathClick = useCallback((payload: PathClickPayload) => {
    void openInEditor({
      path: payload.path,
      line: payload.line,
      ...(payload.column !== undefined ? { column: payload.column } : {}),
    }).then((result: OpenInEditorResult) => {
      if (result.ok) return;
      log.warn('open-in-editor failed', result.reason, result.error?.message);
      showToast({
        kind: 'warning',
        message: openInEditorMessageForReason(result.reason, payload.path),
      });
    });
  }, []);

  // Plain-text URL autolinkification. The `url-detect` module found a clickable
  // URL inside this block's output — we delegate to `features/open-url` which
  // prompts the user for confirmation (pasted URLs may be malicious) and
  // then hands off to the host bridge's optional `openExternalUrl`. OSC 8
  // hyperlinks are handled separately via `onLinkClick`; the renderer
  // guarantees autolinkification never overlaps explicit terminal links.
  const onUrlClick = useCallback((payload: UrlClickPayload) => {
    void openExternalUrlAction({ url: payload.url, kind: payload.kind });
  }, []);

  // Secret detection — scan the currently-rendered spans for well-known
  // credentials. The redaction pipeline:
  //   - Join all span texts into a single buffer.
  //   - Run the detector (patterns in `features/secret-detect`).
  //   - Remember both the match list (for the UI banner / count pill) and a
  //     set of per-span redacted text strings. When we build `renderSpans`
  //     for the final <AnsiOutput />, we swap the redacted text in place of
  //     the original on any span that intersects a match.
  //
  // The memo deps are `version` (streaming bump) and `redactEnabled` +
  // `blockRevealed` — both cheap and identity-stable outside state changes.
  const secretState = useMemo(() => {
    const spans = spansRef.current;
    // Fast exits:
    //   - detection disabled by the master setting
    //   - block has no spans yet
    //   - block is collapsed (peek row does not render the output, and the
    //     detector would uselessly burn CPU joining multi-MB span arrays)
    if (!redactEnabled || spans.length === 0 || collapsed) {
      return { matches: [] as ReadonlyArray<SecretMatch>, redactedTexts: null as null | string[] };
    }
    // Build a flat buffer of span text and parallel offset table so we can
    // project detected ranges back onto per-span slices. Length computation
    // uses the raw text (NOT the post-`applyControlChars` version) because
    // the detector operates on raw decoded bytes and we want the offsets to
    // align with span.text directly.
    const texts = spans.map((s) => s.text);
    const joined = texts.join('');
    // Guard against pathological inputs. 2 MB is far beyond any realistic
    // command output a human would scroll through; above that we skip the
    // scan rather than block the render budget. The user can still toggle
    // redaction off to fall through the whole pipeline.
    if (joined.length > 2 * 1024 * 1024) {
      return { matches: [] as ReadonlyArray<SecretMatch>, redactedTexts: null };
    }
    const matches = detectSecrets(joined);
    if (matches.length === 0) {
      return { matches, redactedTexts: null };
    }
    if (blockRevealed) {
      // User asked to see the secrets — keep matches (so the pill still
      // shows "N secrets") but don't redact the spans.
      return { matches, redactedTexts: null };
    }
    // Project matches onto per-span offsets, rewriting each affected span's
    // text with bullet placeholders. Spans that do not intersect any match
    // are left untouched (shared reference with the original span).
    const redactedTexts: string[] = texts.slice();
    let spanIdx = 0;
    let spanStart = 0;
    let spanEnd = texts[0]?.length ?? 0;
    for (const match of matches) {
      // Advance spanIdx until the match's start falls inside it.
      while (spanIdx < texts.length && spanEnd <= match.start) {
        spanIdx += 1;
        spanStart = spanEnd;
        spanEnd = spanStart + (texts[spanIdx]?.length ?? 0);
      }
      // Walk the possibly-multi-span match and replace each covered slice.
      let remaining = match.end;
      let localIdx = spanIdx;
      let localStart = spanStart;
      let localEnd = spanEnd;
      while (localIdx < texts.length && localStart < remaining) {
        const s = redactedTexts[localIdx]!;
        const from = Math.max(0, match.start - localStart);
        const to = Math.min(s.length, remaining - localStart);
        redactedTexts[localIdx] = s.slice(0, from) + '•'.repeat(Math.max(0, to - from)) + s.slice(to);
        localIdx += 1;
        localStart = localEnd;
        localEnd = localStart + (texts[localIdx]?.length ?? 0);
      }
    }
    return { matches, redactedTexts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, redactEnabled, blockRevealed, collapsed]);

  const renderSpans = useMemo(() => {
    const base = spansRef.current;
    const redacted = secretState.redactedTexts;
    if (!redacted) return base;
    // Build new span objects only for the spans whose text changed. Reusing
    // references for untouched spans keeps the AnsiOutput memo sharp.
    const out = new Array<AnsiSpan>(base.length);
    for (let i = 0; i < base.length; i += 1) {
      const span = base[i]!;
      const newText = redacted[i];
      if (newText === undefined || newText === span.text) {
        out[i] = span;
      } else {
        out[i] = { ...span, text: newText };
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, secretState]);

  // Apply cross-span carriage-return folding. This runs after redaction so
  // secrets are already masked before CR logic can shift text around.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const processedSpans = useMemo(() => foldSpansWithCR(renderSpans), [renderSpans]);

  // Output-search overlay. `useBlockOutputMatches` reads the global store and
  // returns the ranges scoped to THIS block (in block-local rendered-char
  // offsets) plus, optionally, the index of the "current" match. We re-derive
  // per-span ranges every render to stay resilient to streaming chunk appends
  // — the memo deps cover the version bump so allocation is bounded.
  const blockMatches = useBlockOutputMatches(blockId);
  const searchHighlights = useMemo<SearchHighlights | undefined>(() => {
    if (blockMatches.ranges.length === 0) return undefined;
    const texts = spansRef.current.map((s) => applyControlChars(s.text, true));
    const perSpan = distributeRangesToSpans(texts, blockMatches.ranges);
    let activeSpanIndex: number | null = null;
    let activeRangeIndex: number | null = null;
    if (blockMatches.activeLocalIndex !== null) {
      // Walk per-span bucket counts to locate which span owns the active hit.
      let consumed = 0;
      for (let i = 0; i < perSpan.length; i += 1) {
        const bucket = perSpan[i]!;
        if (blockMatches.activeLocalIndex < consumed + bucket.length) {
          activeSpanIndex = i;
          activeRangeIndex = blockMatches.activeLocalIndex - consumed;
          break;
        }
        consumed += bucket.length;
      }
    }
    return {
      perSpan,
      activeSpanIndex,
      activeRangeIndex,
    };
    // `version` is the streaming-spans invalidation signal; recompute when new
    // bytes arrive so late-streamed matches get highlighted.
  }, [blockMatches, version]);

  if (collapsed) {
    // Audit P1 (fix 7): Warp-style summary line
    //   "<command> · <N lines> · <duration> · exit <code>"
    // Segments missing the relevant state are omitted (a still-running block
    // has no exit code; a zero-byte block has no line count). The last-line
    // preview remains as supplementary context beneath for users who want to
    // glance at the final output without expanding.
    const linesLabel = lineCount === 1 ? '1 line' : `${lineCount} lines`;
    const summary: string[] = [command, linesLabel, duration];
    if (exitCode !== null) summary.push(`exit ${exitCode}`);
    if (headerStatus === 'error') summary.push('error');
    if (headerStatus === 'canceled') summary.push('canceled');
    const peek = lastLine(decodedForPeek);
    return (
      <div className={styles.peek} data-testid={`block-peek-${blockId}`}>
        <span className={styles.peekSummary} data-testid={`block-summary-${blockId}`}>
          {summary.join(' · ')}
        </span>
        {peek ? <span className={styles.peekText}>{peek}</span> : null}
        <span className={styles.peekBytes}>{bytes}B</span>
      </div>
    );
  }

  const secretCount = secretState.matches.length;
  const hasSecrets = secretCount > 0;

  return (
    <div className={styles.body}>
      {hasSecrets ? (
        <div
          className={styles.secretBanner}
          data-testid={`block-secret-banner-${blockId}`}
          role="status"
        >
          <span className={styles.secretBannerText}>
            {secretCount === 1
              ? t('blockCard.secrets.count', { count: secretCount })
              : t('blockCard.secrets.countPlural', { count: secretCount })}
          </span>
          <button
            type="button"
            className={styles.secretToggleButton}
            onClick={onToggleSecrets}
            aria-pressed={blockRevealed ? 'true' : 'false'}
            aria-label={
              blockRevealed
                ? t('blockCard.secrets.hideLabel')
                : t('blockCard.secrets.showLabel')
            }
            data-testid={`block-secret-toggle-${blockId}`}
          >
            <EyeIcon open={blockRevealed} />
            <span>
              {blockRevealed
                ? t('blockCard.secrets.hideLabel')
                : t('blockCard.secrets.showLabel')}
            </span>
          </button>
        </div>
      ) : null}
      {spansRef.current.length === 0 ? (
        <div className={styles.empty} data-testid="block-empty">
          {status === 'running' ? 'Waiting for output…' : 'No output.'}
        </div>
      ) : (
        <div data-testid="block-output">
          <AnsiOutput
            spans={processedSpans}
            version={version}
            className={styles.output ?? ''}
            onPathClick={onPathClick}
            onUrlClick={onUrlClick}
            {...(searchHighlights ? { searchHighlights } : {})}
          />
        </div>
      )}
      {errorMessage ? (
        <div className={styles.errorBanner} role="alert">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
});

/* --- Inline SVG icons (no new dep; 14x14 glyphs match the icon button). --- */

function StopIcon() {
  // Solid square — the conventional "stop" / "halt" glyph. Using a filled
  // rect (not a ring) so the red accent is legible at 14px against the
  // icon-button background.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" fill="currentColor" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 1v5l2 2v1H8v4H6V9H5V8l2-2V1h0z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.5 3V2.2A.8.8 0 0 1 6.3 1.5h4.4a.8.8 0 0 1 .8.8v5.6"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function RerunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M12 5.5A5 5 0 1 0 12.5 9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M12.5 2.5V5.5H9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExportIcon() {
  // "Box with arrow" glyph — a conventional export / share mark readable at
  // 14px. Two strokes (arrow + container) so the arrow reads against the
  // icon-button background without extra fills.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 1.5v7.5M4.5 4l2.5-2.5L9.5 4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 8.5v3a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  // Two renders: open-eye (secrets revealed) vs crossed-eye (secrets hidden).
  // Stroke-only so the glyph reads at 14px on any background.
  if (open) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <path
          d="M1.5 7S3.5 2.5 7 2.5 12.5 7 12.5 7 10.5 11.5 7 11.5 1.5 7 1.5 7z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 2l10 10M3 7s2-4.5 5-4.5c1.1 0 2.1.5 2.9 1.1M11 7s-.4 1.1-1.3 2.1M6 11.2c.3.2.7.3 1 .3 3.5 0 5.5-4.5 5.5-4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CompareIcon() {
  // Two parallel bars with a left-right arrowhead — a lightweight mark that
  // reads as "diff / compare" without needing a second row of labels.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3 4h5M3 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M10 2.5l2.5 2L10 6.5M10 7.5l2.5 2L10 11.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
