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
          ? `Already installed in ${outcome.reply.targetPath}.`
          : `Appended to ${outcome.reply.targetPath}. Reload your shell to activate.`,
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
            Install shell integration
          </h2>
          <p className={styles.subtitle}>
            Detected shell: <strong>{detection.shell}</strong>
            {detection.rawShell ? ` (${detection.rawShell})` : null}
          </p>
        </div>

        <div className={styles.body}>
          {state.phase === 'detect' ? (
            <div data-testid="step-detect">
              <p>
                Quanta uses OSC 133 markers to frame command blocks precisely. Without the
                integration script, block boundaries are estimated from prompt text.
              </p>
              <p>
                Click <strong>Preview snippet</strong> to see exactly what would be appended to
                your shell's rc file. Nothing is written until you confirm.
              </p>
            </div>
          ) : null}

          {state.phase === 'preview' ? (
            <div data-testid="step-preview">
              <p>
                This snippet will be appended to{' '}
                <code data-testid="target-path">{state.targetPath}</code>
                {state.alreadyInstalled ? (
                  <> — <strong>it looks like it is already installed</strong>.</>
                ) : (
                  <> ({bodyLineCount} lines of script, wrapped in a guarded block).</>
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
              <p className={styles.error}>{state.message ?? 'Unknown error.'}</p>
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          {state.phase === 'detect' ? (
            <>
              <Button type="button" onClick={onClose} variant="ghost">
                Not now
              </Button>
              <Button
                type="button"
                onClick={goToPreview}
                variant="primary"
                disabled={busy}
                data-testid="wizard-preview-button"
              >
                {busy ? 'Loading…' : 'Preview snippet'}
              </Button>
            </>
          ) : null}

          {state.phase === 'preview' ? (
            <>
              <Button type="button" onClick={onClose} variant="ghost">
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCopy}
                data-testid="wizard-copy-button"
              >
                Copy
              </Button>
              <Button
                type="button"
                onClick={goToConfirm}
                variant="primary"
                disabled={busy}
                data-testid="wizard-install-button"
              >
                {busy ? 'Installing…' : state.alreadyInstalled ? 'Re-check' : 'Install'}
              </Button>
            </>
          ) : null}

          {state.phase === 'done' || state.phase === 'error' ? (
            <Button type="button" onClick={onClose} variant="primary">
              Close
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

Wizard.displayName = 'ShellIntegrationWizard';
