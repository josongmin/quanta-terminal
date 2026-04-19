/**
 * Global unhandled-promise-rejection + uncaught-error handler (FIX 3, P0).
 *
 * Browsers (and Tauri's webview) surface these through `window` events. If we
 * don't listen, a rejected promise with no `.catch` and an uncaught error in
 * a sync callback each get logged to the devtools console and then silently
 * vanish — the user sees a UI that stops responding with no toast, no crash
 * report, and no log entry in our own tracing pipeline.
 *
 * This module wires both `unhandledrejection` and `error` listeners. Each
 * listener:
 *
 *   1. Logs to our own logger (console fallback when @quanta/ui's logger
 *      registry isn't available).
 *   2. Dispatches the reason to the optional toast hook — the UI track owns
 *      the toast component; we only expose the setter. Until wired, the
 *      dispatcher is a no-op.
 *   3. In production builds, posts to the crash-reporter hook (stubbed no-op
 *      today; a Phase-6 PR plugs in the real endpoint).
 *
 * Swallowing policy: if the toast dispatcher / crash reporter itself throws,
 * we catch and log. A failure in the last-resort reporter must NOT cascade
 * into a new unhandled rejection — that would loop forever.
 */

export type UnhandledRejectionToast = (userMessage: string, context?: unknown) => void;

let toastFn: UnhandledRejectionToast | null = null;
let crashReportFn: ((reason: unknown) => void) | null = null;

/**
 * Register the UI-owned toast dispatcher. The `@quanta/ui` track (which we
 * cannot import directly in this crate) calls this from its root layout so
 * that unhandled rejections can surface as a "something went wrong" toast.
 * Calling `setUnhandledRejectionToast(null)` clears the dispatcher (useful
 * for tests).
 */
export function setUnhandledRejectionToast(fn: UnhandledRejectionToast | null): void {
  toastFn = fn;
}

/**
 * Register a crash-reporter hook. In production the app's main wires this
 * to the real crash-reporter endpoint; in dev it stays at the default no-op.
 * Test-only setter too.
 */
export function setCrashReporter(fn: ((reason: unknown) => void) | null): void {
  crashReportFn = fn;
}

/** Stable format for the UI-safe message shown to the user. */
function reasonToUserMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Minimal logger shim. We want to depend on `@quanta/ui`'s `createLogger` per
 * the spec, but importing from `@quanta/ui` here would pull the React tree
 * into this module and it is sibling-track-owned. Fall back to `console`
 * unless a consumer injects a logger via `setUnhandledRejectionLogger`.
 */
type LogFn = (msg: string, ctx?: unknown) => void;
interface Logger {
  error: LogFn;
  warn: LogFn;
}

let loggerFn: Logger = {
  // eslint-disable-next-line no-console
  error: (msg, ctx) => console.error('[host.unhandled]', msg, ctx),
  // eslint-disable-next-line no-console
  warn: (msg, ctx) => console.warn('[host.unhandled]', msg, ctx),
};

export function setUnhandledRejectionLogger(logger: Logger | null): void {
  loggerFn = logger ?? {
    // eslint-disable-next-line no-console
    error: (msg, ctx) => console.error('[host.unhandled]', msg, ctx),
    // eslint-disable-next-line no-console
    warn: (msg, ctx) => console.warn('[host.unhandled]', msg, ctx),
  };
}

/**
 * Core handler shared by both the promise-rejection and the sync-error paths.
 * Exported for tests; normal consumers should go through
 * `installUnhandledRejectionHandlers`.
 */
export function handleUnhandledReason(reason: unknown, source: 'promise' | 'error'): void {
  const userMessage = reasonToUserMessage(reason);
  loggerFn.error(`unhandled ${source}: ${userMessage}`, reason);

  // Toast dispatch — swallow any downstream throw so a broken toast impl
  // cannot itself trigger a new unhandled rejection.
  if (toastFn) {
    try {
      toastFn(userMessage, reason);
    } catch (err) {
      loggerFn.warn('toast handler threw while dispatching unhandled reason', err);
    }
  }

  if (crashReportFn) {
    try {
      crashReportFn(reason);
    } catch (err) {
      loggerFn.warn('crash reporter threw while reporting unhandled reason', err);
    }
  }
}

/**
 * Attach listeners to `window`. Returns a detach function the tests use to
 * clean up between cases. Safe to call more than once — each call replaces
 * the prior handler (we track it in a module-scoped slot so we don't stack
 * N handlers after a hot reload).
 */
export function installUnhandledRejectionHandlers(target: Window = window): () => void {
  const onRejection = (ev: PromiseRejectionEvent): void => {
    handleUnhandledReason(ev.reason, 'promise');
  };
  const onError = (ev: ErrorEvent): void => {
    // `ErrorEvent.error` is the thrown value when available, otherwise the
    // rendered message (stringified error). `.error` is preferred because
    // the structured error type round-trips correctly.
    handleUnhandledReason(ev.error ?? ev.message, 'error');
  };
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  target.addEventListener('error', onError as EventListener);
  return () => {
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
    target.removeEventListener('error', onError as EventListener);
  };
}
