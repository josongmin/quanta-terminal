/**
 * ErrorBoundary — render-time recovery wrapper.
 *
 * Wraps a subtree and, when React raises from a descendant during render or
 * lifecycle, swaps the subtree for a fallback view. The fallback offers two
 * actions so the user is not stuck on a white screen:
 *
 *   - "Reload"  — remount the subtree (bumps a local reset key so children
 *                 rebuild). If reload throws again, we stay in the error state
 *                 with the new error preserved.
 *   - "Report"  — invokes `onReport(error, info)`. Host apps wire this to a
 *                 crash logger (Sentry, OS notification). If omitted, the
 *                 button still copies the error text to the clipboard as a
 *                 best-effort fallback.
 *
 * Errors are logged via `shared/lib/logger.ts` with the `error` level so they
 * appear in production too. The full chain (message, cause, component stack)
 * is included because on-call debugging needs every link.
 *
 * Only one error boundary is strictly required in Phase 1 — around the page.
 * The component is exported for use anywhere a subtree boundary is useful.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from '../button/index.js';
import { createLogger } from '../../lib/logger.js';
import styles from './error-boundary.module.css';

const log = createLogger('error-boundary');

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Optional fallback override. Defaults to the Quanta-styled card. Receives
   * the caught error and both "reload" and "report" handlers.
   */
  readonly fallback?: (context: FallbackContext) => ReactNode;
  /**
   * Called when a subtree error is caught. Hosts wire this to crash reporting.
   */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Called when the user clicks "Report". Hosts wire this to their telemetry.
   * When omitted, a best-effort clipboard copy is attempted.
   */
  readonly onReport?: (error: Error, info: ErrorInfo) => void;
  /**
   * Human label for the surface in the fallback copy. Defaults to "screen".
   * The copy reads: "This ${subject} hit an error it couldn't recover from."
   */
  readonly subject?: string;
}

export interface FallbackContext {
  readonly error: Error;
  readonly info: ErrorInfo | null;
  readonly reload: () => void;
  readonly report: () => void;
  readonly subject: string;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly info: ErrorInfo | null;
  readonly resetKey: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, info: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log the full chain: `cause` carries nested info when a feature wrapped
    // one error in another. Dev on-call reads this in the console / log file.
    log.error(`[ui.error-boundary] caught in "${this.props.subject ?? 'screen'}"`, error.message, {
      stack: error.stack,
      cause: (error as Error & { cause?: unknown }).cause,
      componentStack: info.componentStack,
    });
    this.setState({ info });
    this.props.onError?.(error, info);
  }

  private readonly reload = (): void => {
    this.setState((prev) => ({
      error: null,
      info: null,
      resetKey: prev.resetKey + 1,
    }));
  };

  private readonly report = (): void => {
    const { error, info } = this.state;
    if (!error) return;
    if (this.props.onReport) {
      this.props.onReport(error, info ?? { componentStack: '' });
      return;
    }
    // Fallback: clipboard copy. Quiet-fails if no clipboard.
    const payload = [
      `error: ${error.message}`,
      `stack: ${error.stack ?? '(no stack)'}`,
      info?.componentStack ? `components: ${info.componentStack}` : null,
    ]
      .filter((x): x is string => x !== null)
      .join('\n\n');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(payload);
      }
    } catch {
      // Nothing we can do — host will wire a real reporter.
    }
  };

  override render(): ReactNode {
    const { error, info, resetKey } = this.state;
    const subject = this.props.subject ?? 'screen';
    if (error) {
      const ctx: FallbackContext = {
        error,
        info,
        reload: this.reload,
        report: this.report,
        subject,
      };
      if (this.props.fallback) return this.props.fallback(ctx);
      return <DefaultFallback {...ctx} />;
    }
    // Keying the tree on resetKey forces a remount after "Reload" so stale
    // state in descendants is discarded along with the render attempt.
    return <div key={resetKey}>{this.props.children}</div>;
  }
}

function DefaultFallback(props: FallbackContext) {
  const { error, reload, report, subject } = props;
  return (
    <div className={styles.wrap} role="alert" data-testid="error-boundary-fallback">
      <div className={styles.card}>
        <div className={styles.icon} aria-hidden>
          !
        </div>
        <div className={styles.title}>
          This {subject} hit an error it couldn&apos;t recover from.
        </div>
        <div className={styles.message}>{error.message || 'Unknown error.'}</div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={reload}>
            Reload
          </Button>
          <Button onClick={report}>Report</Button>
        </div>
      </div>
    </div>
  );
}
