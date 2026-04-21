/**
 * AiExplainPanel — renders below a failed BlockCard and offers to explain
 * the non-zero exit via the AI provider.
 *
 * Lifecycle
 * ---------
 *   - Reads the block header to guard against mounting on running / zero-exit
 *     blocks.
 *   - Reads the `aiExplainEnabled` setting; renders null when the master
 *     switch is off.
 *   - Delegates request state to `useExplainBlock`.
 *   - Listens for the global `quanta:explain-block` custom event so the
 *     command palette's "Explain last failure" entry can target the
 *     currently-mounted panel without a direct prop drill.
 *
 * The panel is dismissible — the user can close it and it won't re-appear
 * for this block until the page reloads (dismissal is local state, same
 * policy as CommandCorrectionHint).
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { Spinner } from '../../shared/ui/spinner/index.js';
import { t } from '../../shared/i18n/index.js';
import { useBlockHeader } from '../../entities/block/index.js';
import { useAiExplainSettings } from './settings.js';
import {
  useExplainBlock,
  type UseExplainBlockOptions,
} from './useExplainBlock.js';
import { renderSimpleMarkdown } from './markdown.js';
import styles from './ai-explain-panel.module.css';

/** Custom DOM event name — palette dispatches to explain a specific block. */
export const EXPLAIN_BLOCK_EVENT = 'quanta:explain-block';

export interface ExplainBlockEventDetail {
  readonly blockId: string;
}

export interface AiExplainPanelProps {
  readonly blockId: string;
  /** Tests override the port via this hook option. */
  readonly explainOptions?: UseExplainBlockOptions;
}

function AiExplainPanelImpl(props: AiExplainPanelProps) {
  const { blockId, explainOptions } = props;
  const header = useBlockHeader(blockId);
  const enabled = useAiExplainSettings((s) => s.enabled);
  const [dismissed, setDismissed] = useState(false);
  const { state, explanation, explain, reset } = useExplainBlock(
    blockId,
    explainOptions ?? {},
  );

  const explainRef = useRef(explain);
  useEffect(() => {
    explainRef.current = explain;
  }, [explain]);

  // Listen for a global "explain this block" event so the palette command and
  // the keyboard shortcut can both re-use this panel's request lifecycle
  // without threading a ref up the tree.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<ExplainBlockEventDetail>).detail;
      if (!detail || detail.blockId !== blockId) return;
      explainRef.current();
    };
    window.addEventListener(EXPLAIN_BLOCK_EVENT, onEvent);
    return () => window.removeEventListener(EXPLAIN_BLOCK_EVENT, onEvent);
  }, [blockId]);

  const isFailedTerminal = useMemo(() => {
    if (!header) return false;
    if (header.status === 'running') return false;
    if (header.exitCode === null) return false;
    return header.exitCode !== 0;
  }, [header]);

  const onDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const onExplainClick = useCallback(() => {
    explain();
  }, [explain]);

  const onRetryClick = useCallback(() => {
    reset();
    // Call explain on the next tick — reset() sets state='idle' synchronously
    // via React's batched update, so invoking explain immediately re-enters
    // loading. Wrap in a microtask to ensure the idle transition lands first
    // (so the state machine's guard on `state === 'loading'` doesn't misfire).
    queueMicrotask(() => explainRef.current());
  }, [reset]);

  if (!enabled) return null;
  if (!isFailedTerminal) return null;
  if (dismissed) return null;

  return (
    <div
      className={styles.panel}
      data-state={state}
      data-testid={`ai-explain-panel-${blockId}`}
      role="region"
      aria-label={t('aiExplain.panelLabel')}
    >
      <div className={styles.row}>
        <span className={styles.left}>
          {state === 'idle' ? (
            <>
              <span className={styles.icon} aria-hidden>
                <SparkleIcon />
              </span>
              <span className={styles.label}>{t('aiExplain.idleDescription')}</span>
            </>
          ) : null}
          {state === 'loading' ? (
            <>
              <Spinner size="sm" label={t('aiExplain.loading')} />
              <span className={styles.label}>{t('aiExplain.loading')}</span>
            </>
          ) : null}
          {state === 'error' ? (
            <span className={styles.label}>{t('aiExplain.errorMessage')}</span>
          ) : null}
          {state === 'not-configured' ? (
            <span className={styles.label}>{t('aiExplain.notConfigured')}</span>
          ) : null}
          {state === 'done' ? (
            <span className={styles.icon} aria-hidden>
              <SparkleIcon />
            </span>
          ) : null}
        </span>
        <span className={styles.actions}>
          {state === 'idle' ? (
            <button
              type="button"
              className={styles.explainButton}
              onClick={onExplainClick}
              data-testid={`ai-explain-trigger-${blockId}`}
              aria-label={t('aiExplain.idleLabel')}
            >
              {t('aiExplain.idleLabel')} <Kbd>{t('aiExplain.shortcutHint')}</Kbd>
            </button>
          ) : null}
          {state === 'error' ? (
            <button
              type="button"
              className={styles.retryButton}
              onClick={onRetryClick}
              data-testid={`ai-explain-retry-${blockId}`}
            >
              {t('aiExplain.retry')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.dismissButton}
            onClick={onDismiss}
            aria-label={t('aiExplain.dismiss')}
            data-testid={`ai-explain-dismiss-${blockId}`}
          >
            ×
          </button>
        </span>
      </div>
      {state === 'done' && explanation !== null ? (
        <div
          className={styles.explanation}
          data-testid={`ai-explain-text-${blockId}`}
        >
          {renderSimpleMarkdown(explanation)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Small sparkle glyph — mirrors the "AI" visual cue used elsewhere. Stroke
 * only so it reads at 14px against any theme.
 */
function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 1.5L8 5l3.5 1-3.5 1L7 10.5 6 7 2.5 6 6 5z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M11 10.5l.5 1.5L13 12.5l-1.5.5L11 14.5l-.5-1.5L9 12.5l1.5-.5z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const AiExplainPanel = memo(AiExplainPanelImpl, (prev, next) => {
  return prev.blockId === next.blockId && prev.explainOptions === next.explainOptions;
});

AiExplainPanel.displayName = 'AiExplainPanel';
