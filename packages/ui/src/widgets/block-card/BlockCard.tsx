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
} from 'react';
import { Badge } from '../../shared/ui/badge/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { Tooltip } from '../../shared/ui/tooltip/index.js';
import { Spinner } from '../../shared/ui/spinner/index.js';
import {
  AnsiOutput,
  type AnsiSpan,
  type PathClickPayload,
} from '../../shared/ui/ansi-output/index.js';
import { AnsiParser } from '../../shared/lib/ansi-parser/index.js';
import {
  concatChunks,
  useBlockHeader,
  useBlockOutputChunks,
  useBlockStore,
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
import { cx } from '../../shared/lib/cx.js';
import { createLogger } from '../../shared/lib/logger.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { showToast } from '../../shared/ui/toast/index.js';
import { t } from '../../shared/i18n/index.js';
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
}

// Collapsed peek wants raw text regardless of ANSI state; TextDecoder is the
// right tool there. Module-scoped to avoid allocating per card.
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
  const { block, onRerun, onCopy, onCompare } = props;
  // Subscribe to the chrome view, falling back to the incoming prop on the
  // first render (the store is the source of truth thereafter). `block` is
  // still the entry used by callers that hand-construct a card in isolation
  // (tests, storybook).
  const storeHeader = useBlockHeader(block.id);
  const header: BlockHeaderView = storeHeader ?? toHeaderView(block);

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
  // successor. Reading the store directly here (scan for any block whose
  // `rerunOfId` === this.id) avoids adding a dedicated selector and
  // re-renders infrequently: entity count changes are rare and stable per
  // card's header-view subscription window.
  const hasSuccessor = useBlockStore((s) => {
    for (const id of s.order) {
      const b = s.entities[id];
      if (b && b.rerunOfId === block.id) return true;
    }
    return false;
  });
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

  // Export menu state — a tiny local dropdown. Opens on button click, closes
  // on selection / outside click / Escape.
  const [exportOpen, setExportOpen] = useState(false);
  const exportWrapRef = useRef<HTMLSpanElement | null>(null);
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

  return (
    <article
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
        className={styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={!header.collapsed}
        aria-label={`Block: ${header.command}`}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKey}
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
          <span className={styles.command}>{header.command}</span>
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
                Copy output <Kbd>⌘C</Kbd>
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
                  Rerun <Kbd>⌘R</Kbd>
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

      <BlockBody
        blockId={header.id}
        collapsed={header.collapsed}
        errorMessage={header.errorMessage}
        command={header.command}
        duration={duration}
        exitCode={header.exitCode}
        status={header.status}
      />
    </article>
  );
}

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
    prev.onCompare === next.onCompare
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
  };
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
  const parserRef = useRef<AnsiParser | null>(null);
  const feedCursorRef = useRef(0);
  const spansRef = useRef<AnsiSpan[]>([]);
  const drainedRef = useRef(false);
  const [version, setVersion] = useState(0);

  const chunks = stream?.outputChunks ?? EMPTY_CHUNKS;
  const status = stream?.status ?? 'running';

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
        spansRef.current.push(s);
        appended += 1;
      }
    }
    feedCursorRef.current = chunks.length;

    if (status !== 'running' && drainedRef.current === false) {
      const tail = parserRef.current.flush();
      for (const s of tail) {
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
    return TEXT_DECODER.decode(concatChunks(chunks));
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

  return (
    <div className={styles.body}>
      {spansRef.current.length === 0 ? (
        <div className={styles.empty} data-testid="block-empty">
          {status === 'running' ? 'Waiting for output…' : 'No output.'}
        </div>
      ) : (
        <div data-testid="block-output">
          <AnsiOutput
            spans={spansRef.current}
            version={version}
            className={styles.output ?? ''}
            onPathClick={onPathClick}
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
