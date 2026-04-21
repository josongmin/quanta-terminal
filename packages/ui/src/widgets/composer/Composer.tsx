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
 * SOTA++ input-layer safety:
 *   - Password-mode — when the active block's recent output contains a
 *     password prompt (sudo, ssh passphrase, etc.), the composer auto-
 *     flips to masked rendering: characters render as bullets, the value
 *     is never passed to `onSubmitted` (so the history-ingestion path
 *     skips the entry), and the textarea reports `type="password"` via an
 *     overlay trick below (the element itself stays a textarea for IME /
 *     multi-line paste compatibility; we paint a masked display layer).
 *   - Paste-safety — any paste the analyzer flags as `warn` or `danger`
 *     pops a confirmation dialog before the text lands in the textarea.
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
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { Badge } from '../../shared/ui/badge/index.js';
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
import {
  useActiveBlockId,
  useBlockOutputChunks,
} from '../../entities/block/index.js';
import {
  detectPasswordPrompt,
  tailLines,
} from '../../features/secret-detect/index.js';
import {
  analyze as analyzePaste,
  needsConfirmation,
  PasteConfirmDialog,
  type PasteAnalysis,
} from '../../features/paste-safety/index.js';
import {
  useAutosuggest,
  useHistoryEntries,
} from '../../features/autosuggest/index.js';
import { useHighlighted } from '../../features/shell-highlight/index.js';
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
   *
   * SOTA++ safety: when the composer is in password mode at submit time we
   * deliberately do NOT invoke this callback so password text never reaches
   * the history-ingestion path. The shell still receives the raw bytes
   * because `submitCommand` runs against the bridge independently.
   */
  readonly onSubmitted?: (text: string) => void;
}

const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20; // matches .editor line-height in CSS
/** Number of tail lines of active-block output we scan for a password prompt.
 *  Small so old prompts can't retrigger after the user has moved past them. */
const PASSWORD_PROMPT_TAIL_LINES = 4;
/** Cap the decoded-output window we scan for a prompt. Output can be
 *  megabytes; the prompt is always near the tail. */
const PASSWORD_PROMPT_SCAN_BYTES = 1_024;

const textDecoder: TextDecoder | null =
  typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

/** Cheap tail-of-output decoder for the password-prompt scanner. We do NOT
 *  use the expensive full decoder because the detector only ever looks at
 *  the last few lines. */
function decodeTail(chunks: readonly Uint8Array[]): string {
  if (!textDecoder || chunks.length === 0) return '';
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const take = Math.min(total, PASSWORD_PROMPT_SCAN_BYTES);
  const buf = new Uint8Array(take);
  let remaining = take;
  let writeOffset = take;
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const chunk = chunks[i]!;
    const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(chunk.byteLength - remaining);
    writeOffset -= slice.byteLength;
    buf.set(slice, writeOffset);
    remaining -= slice.byteLength;
  }
  return textDecoder.decode(buf);
}

/** Build the password-prompt detection signal for the active block. Returns
 *  true only when the tail of output currently ends with a prompt-like
 *  signature — the moment the user hits Enter the prompt scrolls away and
 *  this flips back to false on the next render. */
function usePasswordPromptActive(): boolean {
  const activeId = useActiveBlockId();
  // Deliberately subscribe to the block's output stream even when activeId is
  // null, so the hook signature stays stable across renders.
  const stream = useBlockOutputChunks(activeId ?? '');
  return useMemo(() => {
    if (!stream || stream.status !== 'running') return false;
    const chunks = stream.outputChunks;
    if (chunks.length === 0) return false;
    const tail = tailLines(decodeTail(chunks), PASSWORD_PROMPT_TAIL_LINES);
    return detectPasswordPrompt(tail) !== null;
  }, [stream]);
}

export function Composer(props: ComposerProps) {
  const { mode = 'shell', autoFocus = false, onSubmitted } = props;
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Paste-safety: when the analyzer flags a paste we stash the text +
  // analysis and show the dialog. Null fields mean the dialog is closed.
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pasteAnalysis, setPasteAnalysis] = useState<PasteAnalysis | null>(null);
  // Caret position mirrored into state so the autosuggest hook can gate on
  // "caret at end". We read from the textarea node on selection and keyboard
  // events rather than polling each render.
  const [caret, setCaret] = useState(0);
  // Esc-to-dismiss flag — the user explicitly rejected the current suggestion.
  // Clears on the next value change so typing a new character re-enables the
  // affordance (Fish-shell parity: Esc hides until input changes).
  const [autosuggestDismissed, setAutosuggestDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition: browsers fire keydown Enter DURING a composition (e.g.
  // Japanese/Chinese candidate selection) and we must NOT submit in that
  // window. React 17+ exposes `isComposing` on KeyboardEvent but jsdom does
  // not set it consistently, so we track the state explicitly via the
  // compositionstart/end events and gate on that.
  //
  // Ref is the source of truth for the Enter-during-composition guard (sync
  // read inside keydown). State is mirrored so the syntax-highlight overlay
  // re-renders when composition begins/ends and switches to its plain
  // fallback so the composed text isn't rendered twice (once via overlay,
  // once via the textarea's composition caret).
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);

  const passwordMode = usePasswordPromptActive();

  // Inline autosuggest: fish-shell-style greyed-out tail. Gated off in
  // password mode (security), multi-line input, when the caret isn't at the
  // end, or when the user pressed Escape to dismiss.
  const historyEntries = useHistoryEntries();

  // Top-20 recent unique commands for the history panel (Up-arrow).
  // Deduplicated by command text, sorted newest-first.
  const historyCommands = useMemo((): readonly string[] => {
    const seen = new Set<string>();
    const sorted = [...historyEntries].sort((a, b) => b.lastRunAt - a.lastRunAt);
    const out: string[] = [];
    for (const e of sorted) {
      if (!seen.has(e.command)) {
        seen.add(e.command);
        out.push(e.command);
        if (out.length >= 20) break;
      }
    }
    return out;
  }, [historyEntries]);
  const autosuggest = useAutosuggest({
    value,
    caret,
    history: historyEntries,
    passwordMode,
    dismissed: autosuggestDismissed,
  });

  // Syntax highlighting overlay. Disabled in password mode (no point
  // highlighting bullets) and during IME composition (double-render hazard).
  const highlightSpans = useHighlighted({
    value,
    disabled: passwordMode,
    composing,
    styles,
  });

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
      // Track caret after the native change so the autosuggest gate sees the
      // post-edit selectionEnd — the browser has already moved it.
      setCaret(e.target.selectionEnd ?? e.target.value.length);
      // Typing anything un-dismisses the suggestion — user changed the line,
      // show the new completion (Fish-shell parity).
      if (autosuggestDismissed) setAutosuggestDismissed(false);
      if (historyOpen) setHistoryOpen(false);
      if (historyOpen) setHistoryIndex(0);
      // Typing after a failed submit clears the error message: the user is
      // trying a new command, stale context only confuses them.
      if (submitError) setSubmitError(null);
    },
    [autosuggestDismissed, historyOpen, submitError],
  );

  /** Accept the current autosuggest: splice the completion into `value` and
   *  move the caret to the end. Called from both Tab and ArrowRight-at-end. */
  const acceptAutosuggest = useCallback((): boolean => {
    const full = autosuggest.suggestion;
    if (full === null) return false;
    setValue(full);
    // Defer caret placement so React flushes the new value first; otherwise
    // setSelectionRange runs against the stale DOM value and clamps to its
    // pre-update length.
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (!el) return;
      try {
        el.setSelectionRange(full.length, full.length);
      } catch {
        // jsdom ignores on detached textareas; safe to swallow.
      }
      setCaret(full.length);
    });
    return true;
  }, [autosuggest.suggestion]);

  const insertTextAtSelection = useCallback((text: string): void => {
    const el = textareaRef.current;
    if (!el) {
      setValue((prev) => prev + text);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setValue((prev) => prev.slice(0, start) + text + prev.slice(end));
    // Restore cursor position after React has flushed the new value.
    queueMicrotask(() => {
      const node = textareaRef.current;
      if (!node) return;
      const next = start + text.length;
      try {
        node.setSelectionRange(next, next);
      } catch {
        // jsdom ignores when textarea is detached; safe to swallow.
      }
    });
  }, []);

  const handlePaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const pasted = e.clipboardData.getData('text') ?? '';
      if (pasted.length === 0) return;
      const analysis = analyzePaste(pasted);
      if (!needsConfirmation(analysis)) return;
      // Risky paste: intercept the native insertion and show the dialog.
      e.preventDefault();
      setPendingPaste(pasted);
      setPasteAnalysis(analysis);
    },
    [],
  );

  const cancelPaste = useCallback(() => {
    setPendingPaste(null);
    setPasteAnalysis(null);
    // Return focus to the textarea; the dialog stole it via the focus-trap.
    queueMicrotask(() => textareaRef.current?.focus());
  }, []);

  const confirmPaste = useCallback(() => {
    if (pendingPaste !== null) {
      insertTextAtSelection(pendingPaste);
    }
    setPendingPaste(null);
    setPasteAnalysis(null);
    queueMicrotask(() => textareaRef.current?.focus());
  }, [pendingPaste, insertTextAtSelection]);

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    if (value.length === 0) return;
    // Password mode: even whitespace-only is a legitimate answer (empty
    // passphrase, Enter-past-prompt), so we relax the "trim empty" guard.
    if (!passwordMode && value.trim().length === 0) return;
    const wasPasswordMode = passwordMode;
    const submittedValue = value;
    setBusy(true);
    setSubmitError(null);
    const result = await submitCommand({ text: submittedValue, mode });
    setBusy(false);
    if (result.ok) {
      // SOTA++ safety: do NOT invoke `onSubmitted` in password mode. The
      // callback is the signal history ingestion listens on; skipping it
      // keeps the typed credential out of the recent-commands index.
      if (!wasPasswordMode) onSubmitted?.(submittedValue);
      setValue('');
      setCaret(0);
      setAutosuggestDismissed(false);
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
  }, [busy, mode, onSubmitted, passwordMode, value]);

  const handleCompositionStart = useCallback((_e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true;
    setComposing(true);
  }, []);
  const handleCompositionEnd = useCallback((_e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    setComposing(false);
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
      // Tab accepts the autosuggest if one is visible. We do this BEFORE the
      // ArrowUp / Escape branches so a suggestion's presence wins over any
      // other Tab-focus traversal (the textarea is the only tab-stop in the
      // composer row anyway).
      if (e.key === 'Tab' && !e.shiftKey && autosuggest.suggestion !== null) {
        e.preventDefault();
        acceptAutosuggest();
        return;
      }
      // ArrowRight at end-of-buffer also accepts — the cursor is already at
      // the tail, so "moving right" means "swallow the ghost tail into
      // typed text". Mid-line ArrowRight falls through to the native caret
      // move so selection behaviour is unchanged.
      if (
        e.key === 'ArrowRight' &&
        !e.shiftKey &&
        autosuggest.suggestion !== null &&
        e.currentTarget.selectionStart === e.currentTarget.value.length &&
        e.currentTarget.selectionEnd === e.currentTarget.value.length
      ) {
        e.preventDefault();
        acceptAutosuggest();
        return;
      }
      if (e.key === 'ArrowUp' && !e.shiftKey) {
        if (passwordMode) return;
        const el = e.currentTarget;
        const upToCursor = el.value.slice(0, el.selectionStart);
        if (!upToCursor.includes('\n')) {
          e.preventDefault();
          if (historyOpen) {
            // Navigate up the history list (index 0 = most recent).
            setHistoryIndex((i) => Math.max(0, i - 1));
          } else {
            setHistoryOpen(true);
            setHistoryIndex(0);
          }
        }
        return;
      }
      if (e.key === 'ArrowDown' && !e.shiftKey && historyOpen) {
        e.preventDefault();
        setHistoryIndex((i) => Math.min(historyCommands.length - 1, i + 1));
        return;
      }
      if (e.key === 'Enter' && historyOpen) {
        e.preventDefault();
        const cmd = historyCommands[historyIndex];
        if (cmd !== undefined) {
          setValue(cmd);
          setCaret(cmd.length);
          queueMicrotask(() => {
            const el = textareaRef.current;
            if (!el) return;
            try { el.setSelectionRange(cmd.length, cmd.length); } catch { /* jsdom */ }
          });
        }
        setHistoryOpen(false);
        setHistoryIndex(0);
        return;
      }
      if (e.key === 'Escape') {
        if (autosuggest.suggestion !== null && !autosuggestDismissed) {
          e.preventDefault();
          setAutosuggestDismissed(true);
          return;
        }
        if (historyOpen) {
          e.preventDefault();
          setHistoryOpen(false);
          setHistoryIndex(0);
        }
      }
    },
    [
      acceptAutosuggest,
      autosuggest.suggestion,
      autosuggestDismissed,
      handleSubmit,
      historyCommands,
      historyIndex,
      historyOpen,
      passwordMode,
    ],
  );

  /** Caret-position mirror. `onSelect` fires after every arrow-key move,
   *  click, or programmatic setSelectionRange that a browser observes, so
   *  reading selectionEnd there keeps our `caret` state in sync without
   *  polling. */
  const handleSelect = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const next = el.selectionEnd ?? el.value.length;
    setCaret(next);
  }, []);

  // The rendered mask used in password mode: every non-newline character is
  // swapped for a bullet so the text is visually hidden while the actual
  // value is preserved in component state. Newlines survive so multi-line
  // textarea auto-sizing still reflects structure.
  const displayValue = useMemo(() => {
    if (!passwordMode) return value;
    let out = '';
    for (const ch of value) {
      out += ch === '\n' ? '\n' : '\u2022';
    }
    return out;
  }, [passwordMode, value]);

  return (
    <div
      className={cx(styles.wrap, focused && styles.focused)}
      data-focused={focused ? 'true' : 'false'}
      data-password-mode={passwordMode ? 'true' : 'false'}
      data-testid="composer"
    >
      {historyOpen ? (
        <div
          className={styles.history}
          role="listbox"
          aria-label={t('composer.recentCommandsLabel')}
          aria-activedescendant={
            historyCommands.length > 0 ? `qhist-${historyIndex}` : undefined
          }
        >
          {historyCommands.length === 0 ? (
            <div className={styles.historyEmpty}>
              No recent commands. Press <Kbd>Esc</Kbd> to close.
            </div>
          ) : (
            <>
              <div className={styles.historyHeader}>Recent commands</div>
              {historyCommands.map((cmd, idx) => (
                <div
                  key={cmd}
                  id={`qhist-${idx}`}
                  role="option"
                  aria-selected={idx === historyIndex}
                  className={cx(
                    styles.historyItem,
                    idx === historyIndex && styles.historyItemActive,
                  )}
                  onMouseEnter={() => setHistoryIndex(idx)}
                  onClick={() => {
                    setValue(cmd);
                    setCaret(cmd.length);
                    setHistoryOpen(false);
                    setHistoryIndex(0);
                    queueMicrotask(() => {
                      const el = textareaRef.current;
                      if (!el) return;
                      el.focus();
                      try { el.setSelectionRange(cmd.length, cmd.length); } catch { /* jsdom */ }
                    });
                  }}
                >
                  <span className={styles.historyItemCmd}>{cmd}</span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
      <div className={styles.row}>
        <span className={styles.prompt} aria-hidden>
          &gt;
        </span>
        <label className={styles.srOnly} htmlFor="quanta-composer-input">
          {t('composer.inputLabel')}
        </label>
        <div className={styles.editorWrap}>
          {!passwordMode && !composing && highlightSpans.length > 0 ? (
            <div
              className={styles.highlight}
              aria-hidden="true"
              data-testid="composer-highlight"
            >
              {highlightSpans.map((span, idx) => (
                <span
                  key={idx}
                  className={span.className ?? undefined}
                >
                  {span.text}
                </span>
              ))}
            </div>
          ) : null}
          {autosuggest.tail !== null ? (
            <div
              className={styles.ghost}
              aria-hidden="true"
              data-testid="composer-autosuggest"
            >
              {/*
                The typed value is rendered in transparent text so its layout
                width matches the textarea's typed characters exactly — using
                the same font metrics the browser applies to the <textarea>.
                Only the tail carries visible colour, so the user sees a
                greyed-out continuation appearing to the right of the caret.
              */}
              <span className={styles.ghostSpacer}>{value}</span>
              <span className={styles.ghostTail}>{autosuggest.tail}</span>
            </div>
          ) : null}
        <textarea
          id="quanta-composer-input"
          ref={textareaRef}
          className={cx(
            styles.editor,
            !passwordMode && !composing && highlightSpans.length > 0 && styles.editorTransparent,
          )}
          value={displayValue}
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={t('composer.placeholder')}
          onChange={(e) => {
            // In password mode, the textarea's `value` we set is the masked
            // version (bullets). A native `onChange` reports the masked string
            // as the user's input — we can't use it directly. Instead, diff
            // the lengths: if the user added characters, splice them from the
            // end of `e.target.value` (the unmasked character the user typed
            // is what the browser just appended in-place before we overwrote
            // the value on the next render — but since React's controlled
            // input echoes back our masked value synchronously, `selection`
            // and `selectionEnd` give us the insertion point).
            if (!passwordMode) {
              handleChange(e);
              return;
            }
            // Compute inserted text by comparing the display-masked previous
            // value to the new textarea value. Anything that is NOT a bullet
            // (or newline) is fresh user input.
            const nextTextareaValue = e.target.value;
            const prevMasked = displayValue;
            // Fast path: backspace — the textarea value is shorter than the
            // masked prior value. Trim the real `value` to match the new
            // length, preserving newline structure.
            if (nextTextareaValue.length < prevMasked.length) {
              const shrinkBy = prevMasked.length - nextTextareaValue.length;
              setValue((prev) => prev.slice(0, Math.max(0, prev.length - shrinkBy)));
              return;
            }
            // Insertion path: find the first character that differs from a
            // bullet / newline — that's the newly typed character.
            const insertedParts: string[] = [];
            for (let i = 0; i < nextTextareaValue.length; i += 1) {
              const ch = nextTextareaValue[i]!;
              if (ch !== '\u2022' && ch !== '\n') {
                insertedParts.push(ch);
              }
            }
            const inserted = insertedParts.join('');
            // Real value is effectively whatever unmasked characters appear
            // in the new textarea value. We append them to the tail of the
            // real state, preserving previously-typed characters.
            setValue((prev) => {
              // If inserted length equals the textarea length growth, append
              // at the end; otherwise fall back to a full rebuild.
              const growth = nextTextareaValue.length - prevMasked.length;
              if (inserted.length === growth) {
                return prev + inserted;
              }
              // Rebuild: any position where the new textarea value is a
              // bullet / newline stays from `prev`; other positions are the
              // new character.
              const rebuiltParts: string[] = [];
              for (let i = 0; i < nextTextareaValue.length; i += 1) {
                const ch = nextTextareaValue[i]!;
                if (ch === '\u2022') {
                  rebuiltParts.push(prev[i] ?? '');
                } else {
                  rebuiltParts.push(ch);
                }
              }
              return rebuiltParts.join('');
            });
            setCaret(e.target.selectionEnd ?? e.target.value.length);
            if (autosuggestDismissed) setAutosuggestDismissed(false);
            if (submitError) setSubmitError(null);
            if (historyOpen) setHistoryOpen(false);
          }}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-busy={busy}
          aria-multiline
          aria-invalid={submitError !== null}
          aria-describedby={
            submitError !== null
              ? 'quanta-composer-error'
              : passwordMode
                ? 'quanta-composer-password-hint'
                : undefined
          }
          disabled={busy}
          data-testid="composer-input"
        />
        </div>
        <Separator />
        {passwordMode ? (
          <Badge
            label={t('composer.passwordMode')}
            tone="warning"
            srDescription={t('composer.passwordMode.aria')}
            data-testid="composer-password-indicator"
          />
        ) : (
          <div className={styles.modeChip} aria-label={t('composer.modeLabel', { mode })}>
            {mode}
          </div>
        )}
      </div>
      {passwordMode ? (
        <span id="quanta-composer-password-hint" className={styles.srOnly}>
          {t('composer.passwordMode.aria')}
        </span>
      ) : null}
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
      <PasteConfirmDialog
        text={pendingPaste}
        analysis={pasteAnalysis}
        onCancel={cancelPaste}
        onConfirm={confirmPaste}
      />
    </div>
  );
}

Composer.displayName = 'Composer';
