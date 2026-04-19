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
 *
 * Audit P1 (fix 8): production error text is SCRUBBED before rendering.
 * Raw `error.message` can leak absolute file paths, stack traces, IPs,
 * emails, and JWT-ish tokens — none of which belong in a user-visible
 * fallback. The scrubbed form is safe to show; the logger still receives
 * the raw chain so on-call debugging is not blind.
 *
 * The component also implements a short-window rate limit: if the same
 * error message recurs 10+ times inside 5s, the fallback collapses to a
 * generic "unexpected error" message instead of the specific text. This
 * prevents an infinite render loop from filling the screen with repeated
 * scrubbed strings (and, worse, from leaking any pattern the scrubber
 * missed — defense in depth).
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from '../button/index.js';
import { createLogger } from '../../lib/logger.js';
import styles from './error-boundary.module.css';

const log = createLogger('ui.error-boundary');

/**
 * Audit P1 (fix 8): redact the usual suspects before rendering a user-facing
 * error message. The substitutions intentionally produce readable placeholders
 * (`<path>`, `<email>`, …) so the user can still tell *what kind* of detail
 * was elided; support asking for "the full text" should redirect to the logs.
 *
 * Order matters: stack frames are matched first (the regex captures a path +
 * line:col that would otherwise be caught piecewise by the absolute-path
 * and IP rules). URL-ish patterns are intentionally left alone — telling a
 * user "we couldn't reach api.acme.com" is legitimately useful.
 */
export function scrubErrorMessage(msg: string): string {
  if (!msg) return '';
  let out = msg;

  // Stack-frame-shaped: `at FnName (/abs/path:line:col)` or `at fn (file.ts:12:34)`.
  // Collapsed to `at <fn> (<loc>)` — keeps "this is a stack frame" legible
  // without exposing the real symbol or location.
  out = out.replace(
    /\bat\s+[^\s()]+\s*\([^()\n]*:\d+:\d+\)/gu,
    'at <fn> (<loc>)',
  );
  // Bare `file.ts:12:34` (no "at" prefix) — still a stack-ish locator.
  out = out.replace(/(?:\/[\w.@-]+)+:\d+:\d+/gu, '<loc>');

  // Absolute POSIX paths: `/Users/...`, `/home/...`, `/var/...`, `/tmp/...`,
  // `/opt/...`, `/etc/...`. Conservative — avoids gobbling URLs.
  out = out.replace(
    /(?<![\w./])\/(?:Users|home|var|tmp|opt|etc|root|private)\/[^\s'"]+/gu,
    '<path>',
  );
  // Windows drive paths: `C:\Users\...`, `D:\foo\bar`.
  out = out.replace(/(?<![\w:])[A-Za-z]:\\[^\s'"]+/gu, '<path>');

  // Email addresses.
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
    '<email>',
  );

  // IPv4 addresses (conservative — four 1–3 digit octets).
  out = out.replace(
    /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu,
    '<ip>',
  );

  // JWT-ish triple-dot tokens `header.payload.signature`, each segment
  // base64url of reasonable length.
  out = out.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    '<token>',
  );
  // Generic long API-key-ish tokens: 32+ chars of hex / base64url.
  out = out.replace(
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/gu,
    '<token>',
  );

  return out;
}

/**
 * Audit P1 (fix 8): render-loop guard. Key by scrubbed message so two
 * different raw strings that scrub to the same redacted form share a bucket
 * (the pathological case we want to collapse).
 */
const ERROR_LOOP_WINDOW_MS = 5_000;
const ERROR_LOOP_MAX_REPEATS = 10;
const errorLoopBuckets = new Map<string, number[]>();

function recordErrorForLoopDetection(scrubbed: string): boolean {
  const now = Date.now();
  const existing = errorLoopBuckets.get(scrubbed) ?? [];
  const pruned = existing.filter((t) => now - t < ERROR_LOOP_WINDOW_MS);
  pruned.push(now);
  errorLoopBuckets.set(scrubbed, pruned);
  return pruned.length >= ERROR_LOOP_MAX_REPEATS;
}

/** Test-only: reset the loop-detection state between cases. */
export function __resetErrorLoopForTests(): void {
  errorLoopBuckets.clear();
}

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
  // Audit P1 (fix 8): scrub the raw message before it reaches the DOM. If
  // the same scrubbed text has shown up too many times inside the loop
  // window, collapse to a generic fallback to keep render loops from
  // splattering the screen with copies.
  const scrubbed = scrubErrorMessage(error.message || '');
  const looping = recordErrorForLoopDetection(scrubbed || '<empty>');
  const displayed = looping
    ? 'An unexpected error occurred.'
    : scrubbed || 'Unknown error.';
  return (
    <div className={styles.wrap} role="alert" data-testid="error-boundary-fallback">
      <div className={styles.card}>
        <div className={styles.icon} aria-hidden>
          !
        </div>
        <div className={styles.title}>
          This {subject} hit an error it couldn&apos;t recover from.
        </div>
        <div className={styles.message}>{displayed}</div>
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
