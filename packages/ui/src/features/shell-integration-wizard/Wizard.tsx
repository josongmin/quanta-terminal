/**
 * Shell-integration install wizard — 3-step modal.
 *
 * Steps:
 *   1. detect  — classify the session's shell, show a "what this does" blurb,
 *                and give the user a "Preview snippet" button.
 *   2. preview — fetch the snippet via the bridge (NO mutation), render it
 *                in a code block, expose "Copy to clipboard" + "Install".
 *   3. confirm — call the bridge with `confirm: true` and report outcome.
 *
 * The wizard is controlled: the parent owns the `open` state (the banner
 * widget toggles it). This keeps the wizard trivially testable and decouples
 * it from any one entry point (banner, command palette, settings page).
 *
 * Typed-to-confirm: opening the wizard does NOT run any install command.
 * Only the Confirm button in step 3 calls `install(shell, userConfirmed=true)`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Button } from '../../shared/ui/button/index.js';
import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { t } from '../../shared/i18n/index.js';
import {
  install as installAction,
  preview as previewAction,
  countSnippetLines,
  type InstallActionOutcome,
} from './install.js';
import type { DetectionResult } from './detect.js';
import styles from './wizard.module.css';

export interface WizardProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The detection result; the parent runs `detect()` before opening. */
  readonly detection: DetectionResult;
  /**
   * Override the bridge call site for tests. When omitted, the real
   * `install.ts` helpers are used.
   */
  readonly overrides?: {
    readonly preview?: typeof previewAction;
    readonly install?: typeof installAction;
  };
}

type WizardPhase = 'detect' | 'preview' | 'confirm' | 'done' | 'error';

interface WizardState {
  readonly phase: WizardPhase;
  readonly snippet: string;
  readonly targetPath: string;
  readonly alreadyInstalled: boolean;
  readonly lineCount: number;
  readonly message: string | null;
  readonly outcome: InstallActionOutcome['kind'] | null;
}

const INITIAL: WizardState = {
  phase: 'detect',
  snippet: '',
  targetPath: '',
  alreadyInstalled: false,
  lineCount: 0,
  message: null,
  outcome: null,
};

export function Wizard(props: WizardProps) {
  const { open, onClose, detection, overrides } = props;
  const [state, setState] = useState<WizardState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const previewFn = overrides?.preview ?? previewAction;
  const installFn = overrides?.install ?? installAction;

  // Activate focus trap on open; reset state on close.
  useEffect(() => {
    if (!open) {
      setState(INITIAL);
      setBusy(false);
      return;
    }
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (!container) return;
    container.focus();
    const trap = activateFocusTrap(container);
    return () => {
      trap.deactivate();
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') target.focus();
      previouslyFocused.current = null;
    };
  }, [open]);

  const goToPreview = useCallback(async () => {
    setBusy(true);
    const outcome = await previewFn(detection.shell);
    setBusy(false);
    if (outcome.kind === 'error') {
      setState((s) => ({ ...s, phase: 'error', message: outcome.message }));
      return;
    }
    setState((s) => ({
      ...s,
      phase: 'preview',
      snippet: outcome.reply.snippet,
      targetPath: outcome.reply.targetPath,
      alreadyInstalled: outcome.reply.alreadyInstalled,
      lineCount: outcome.reply.lineCount,
      message: null,
    }));
  }, [detection.shell, previewFn]);

  const goToConfirm = useCallback(async () => {
    setBusy(true);
    // userConfirmed = true is the typed-to-confirm gate. We pass it from the
    // click handler so a future refactor that accidentally wires this to
    // another event has to lie about consent to bypass the install guard.
    const outcome = await installFn(detection.shell, /* userConfirmed */ true);
    setBusy(false);
    if (outcome.kind === 'error') {
      setState((s) => ({ ...s, phase: 'error', message: outcome.message, outcome: 'error' }));
      return;
    }
    setState((s) => ({
      ...s,
      phase: 'done',
      targetPath: outcome.reply.targetPath,
      lineCount: outcome.reply.lineCount,
      alreadyInstalled: outcome.reply.alreadyInstalled,
      outcome: outcome.kind,
      message:
        outcome.kind === 'already-installed'
          ? t('wizard.done.alreadyInstalled', { path: outcome.reply.targetPath })
          : t('wizard.done.appended', { path: outcome.reply.targetPath }),
    }));
  }, [detection.shell, installFn]);

  const handleCopy = useCallback(() => {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || !nav.clipboard) return;
    nav.clipboard.writeText(state.snippet).catch(() => {
      // We intentionally swallow — the UI should not crash over a failed
      // clipboard write. The Install button is still available.
    });
  }, [state.snippet]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  if (!open) return null;

  const bodyLineCount = countSnippetLines(state.snippet);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropClick}
      data-testid="shell-integration-wizard-backdrop"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quanta-si-wizard-title"
        className={styles.panel}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id="quanta-si-wizard-title" className={styles.title}>
            {t('wizard.title')}
          </h2>
          <p className={styles.subtitle}>
            {t('wizard.detectedShell')}<strong>{detection.shell}</strong>
            {detection.rawShell ? ` (${detection.rawShell})` : null}
          </p>
        </div>

        <div className={styles.body}>
          {state.phase === 'detect' ? (
            <div data-testid="step-detect">
              <p>{t('wizard.detect.intro')}</p>
              <p>{t('wizard.detect.cta')}</p>
            </div>
          ) : null}

          {state.phase === 'preview' ? (
            <div data-testid="step-preview">
              <p>
                {t('wizard.preview.intro')}
                <code data-testid="target-path">{state.targetPath}</code>
                {state.alreadyInstalled ? (
                  <> — <strong>{t('wizard.preview.alreadyInstalled')}</strong>.</>
                ) : (
                  <> ({t('wizard.preview.lineCount', { count: bodyLineCount })}).</>
                )}
              </p>
              <pre className={styles.snippet} data-testid="snippet-preview">
                {state.snippet}
              </pre>
            </div>
          ) : null}

          {state.phase === 'done' ? (
            <div data-testid="step-done">
              <p className={styles.success}>{state.message}</p>
            </div>
          ) : null}

          {state.phase === 'error' ? (
            <div data-testid="step-error">
              <p className={styles.error}>{state.message ?? t('wizard.error.unknown')}</p>
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          {state.phase === 'detect' ? (
            <>
              <Button type="button" onClick={onClose} variant="ghost">
                {t('wizard.button.notNow')}
              </Button>
              <Button
                type="button"
                onClick={goToPreview}
                variant="primary"
                disabled={busy}
                data-testid="wizard-preview-button"
              >
                {busy ? t('wizard.button.previewLoading') : t('wizard.button.preview')}
              </Button>
            </>
          ) : null}

          {state.phase === 'preview' ? (
            <>
              <Button type="button" onClick={onClose} variant="ghost">
                {t('wizard.button.cancel')}
              </Button>
              <Button
                type="button"
                onClick={handleCopy}
                data-testid="wizard-copy-button"
              >
                {t('wizard.button.copy')}
              </Button>
              <Button
                type="button"
                onClick={goToConfirm}
                variant="primary"
                disabled={busy}
                data-testid="wizard-install-button"
              >
                {busy
                  ? t('wizard.button.installLoading')
                  : state.alreadyInstalled
                    ? t('wizard.button.recheck')
                    : t('wizard.button.install')}
              </Button>
            </>
          ) : null}

          {state.phase === 'done' || state.phase === 'error' ? (
            <Button type="button" onClick={onClose} variant="primary">
              {t('wizard.button.close')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

Wizard.displayName = 'ShellIntegrationWizard';
