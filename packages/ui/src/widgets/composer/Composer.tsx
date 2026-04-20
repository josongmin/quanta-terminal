/**
 * Composer — bottom input affordance, a real input this time.
 *
 * Design:
 *   - A multi-line `<textarea>` auto-sizes between one and six lines.
 *   - Enter submits via `features/composer/submit`, Shift+Enter inserts a
 *     newline, Up at the first line opens the "recent commands" scaffold.
 *   - A mode chip on the right ("shell / intent / auto") is structurally
 *     present; Phase 1 always renders "shell" because the intent pipeline
 *     hasn't shipped.
 *   - A hairline inner stroke + glow appears on focus via a
 *     `data-focused="true"` attribute — keeps the motion token on the div,
 *     not a pseudo-element that CSS modules can't style.
 *
 * Why textarea, not contenteditable: with IME, paste, undo, selection, and
 * cursor behaviour you get all three "for free" from the platform. A
 * contenteditable would need a dozen edge cases for the same outcome.
 * CodeMirror is a future upgrade when syntax highlighting matters (PR gate
 * on line ≥2 of input).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { Separator } from '../../shared/ui/separator/index.js';
import {
  applyInsert,
  onComposerInsertText,
  submitCommand,
  type ComposerMode,
} from '../../features/composer/index.js';
import { cx } from '../../shared/lib/cx.js';
import { createLogger } from '../../shared/lib/logger.js';
import { t } from '../../shared/i18n/index.js';
import styles from './composer.module.css';

const log = createLogger('composer');

export interface ComposerProps {
  /** Phase 1: always 'shell'. Prop exists so the chip's state is explicit. */
  readonly mode?: ComposerMode;
  /** Focus the textarea on mount. Default false — the terminal owns focus first. */
  readonly autoFocus?: boolean;
  /**
   * Called after a successful submit. Lets the caller log to a history store
   * or flash the terminal surface.
   */
  readonly onSubmitted?: (text: string) => void;
}

const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20; // matches .editor line-height in CSS

export function Composer(props: ComposerProps) {
  const { mode = 'shell', autoFocus = false, onSubmitted } = props;
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition: browsers fire keydown Enter DURING a composition (e.g.
  // Japanese/Chinese candidate selection) and we must NOT submit in that
  // window. React 17+ exposes `isComposing` on KeyboardEvent but jsdom does
  // not set it consistently, so we track the state explicitly via the
  // compositionstart/end events and gate on that.
  const composingRef = useRef(false);

  // Auto-size. Measured from scrollHeight, clamped between MIN and MAX lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const desired = Math.min(
      MAX_ROWS,
      Math.max(MIN_ROWS, Math.ceil(el.scrollHeight / LINE_HEIGHT_PX)),
    );
    el.style.height = `${desired * LINE_HEIGHT_PX}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // External text insertion (drag-and-drop of files, paste-from-toolbar, etc.).
  // We use a window-level CustomEvent bus (see features/composer/insertText)
  // instead of a ref so siblings stay decoupled from the widget instance.
  useEffect(() => {
    return onComposerInsertText((detail) => {
      setValue((prev) => applyInsert(prev, detail));
      if (detail.focus) {
        // Defer focus until the state has flushed so the cursor lands at the
        // end of the freshly-inserted text.
        queueMicrotask(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const len = el.value.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            // Some environments (jsdom on disabled textareas) throw.
          }
        });
      }
    });
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      if (historyOpen) setHistoryOpen(false);
      // Typing after a failed submit clears the error message: the user is
      // trying a new command, stale context only confuses them.
      if (submitError) setSubmitError(null);
    },
    [historyOpen, submitError],
  );

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    if (value.trim().length === 0) return;
    setBusy(true);
    setSubmitError(null);
    const result = await submitCommand({ text: value, mode });
    setBusy(false);
    if (result.ok) {
      onSubmitted?.(value);
      setValue('');
      return;
    }
    // Surface failure. Keep the text so the user can retry. Log every branch
    // at `warn` — these are correctable conditions, not crashes.
    if (result.reason === 'no-session') {
      setSubmitError(t('composer.error.noSession'));
      log.warn('submit rejected: no active session');
      return;
    }
    if (result.reason === 'no-bridge') {
      setSubmitError(t('composer.error.noBridge'));
      log.warn('submit rejected: no host bridge');
      return;
    }
    if (result.reason === 'empty') {
      // Silent — the early-return guard above usually catches this path.
      return;
    }
    if (result.reason === 'degraded') {
      // Session is in RFC §20 degraded state; the banner already tells the
      // user what happened. No inline error — the drop is visible through
      // the `droppedInputs` telemetry counter and the banner.
      log.debug('submit dropped: engine degraded');
      return;
    }
    const detail = result.error?.message ?? 'unknown failure';
    setSubmitError(t('composer.error.writeRejected', { detail }));
    log.warn('bridge.write rejected during composer submit', result.error);
  }, [busy, mode, onSubmitted, value]);

  const handleCompositionStart = useCallback((_e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback((_e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
  }, []);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Do not submit during an IME composition. Some browsers (Safari)
        // also set `e.isComposing` natively; we check both.
        if (composingRef.current || e.nativeEvent.isComposing) {
          return;
        }
        e.preventDefault();
        void handleSubmit();
        return;
      }
      if (e.key === 'ArrowUp' && !e.shiftKey) {
        // Open history only when the cursor is at the start of the first line.
        const el = e.currentTarget;
        const upToCursor = el.value.slice(0, el.selectionStart);
        if (!upToCursor.includes('\n')) {
          e.preventDefault();
          setHistoryOpen(true);
        }
        return;
      }
      if (e.key === 'Escape' && historyOpen) {
        e.preventDefault();
        setHistoryOpen(false);
      }
    },
    [handleSubmit, historyOpen],
  );

  return (
    <div
      className={cx(styles.wrap, focused && styles.focused)}
      data-focused={focused ? 'true' : 'false'}
      data-testid="composer"
    >
      {historyOpen ? (
        <div className={styles.history} role="listbox" aria-label={t('composer.recentCommandsLabel')}>
          <div className={styles.historyEmpty}>
            No recent commands yet. Press <Kbd>Esc</Kbd> to close.
          </div>
        </div>
      ) : null}
      <div className={styles.row}>
        <span className={styles.prompt} aria-hidden>
          &gt;
        </span>
        <label className={styles.srOnly} htmlFor="quanta-composer-input">
          {t('composer.inputLabel')}
        </label>
        <textarea
          id="quanta-composer-input"
          ref={textareaRef}
          className={styles.editor}
          value={value}
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={t('composer.placeholder')}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-busy={busy}
          aria-multiline
          aria-invalid={submitError !== null}
          aria-describedby={submitError !== null ? 'quanta-composer-error' : undefined}
          disabled={busy}
        />
        <Separator />
        <div className={styles.modeChip} aria-label={t('composer.modeLabel', { mode })}>
          {mode}
        </div>
      </div>
      {submitError ? (
        <div
          id="quanta-composer-error"
          className={styles.error}
          role="alert"
          data-testid="composer-error"
        >
          {submitError}
        </div>
      ) : null}
    </div>
  );
}

Composer.displayName = 'Composer';
