/**
 * Debounce / throttle helpers.
 *
 * Scope: only the variants we actually need in the terminal path. A single
 * `createDebouncer` is used for the fit/resize pipeline: the ResizeObserver
 * can fire 60+ times/sec during a window drag; without this, we'd flood the
 * PTY with `resize()` calls.
 *
 * The returned handle exposes `cancel()` so the caller can tear down pending
 * timers on unmount — the brief calls out every timer/observer needs a
 * matching cleanup, enforced by tests.
 */

export interface Debouncer {
  /** Schedule (or re-schedule) an invocation. */
  schedule(): void;
  /** Fire the callback now if a call is pending; do nothing otherwise. */
  flush(): void;
  /** Drop any pending invocation without firing. Safe on unmount. */
  cancel(): void;
  /** Test hook. */
  readonly isPending: boolean;
}

export interface DebounceOptions {
  readonly wait: number;
  /** If true, the callback fires on the leading edge as well. Default false. */
  readonly leading?: boolean;
  /** Maximum time the callback may be deferred even if calls keep coming. */
  readonly maxWait?: number;
}

/**
 * Create a trailing-edge debouncer. When `schedule()` is called repeatedly,
 * the callback fires `wait` ms after the last call. Use `maxWait` to cap the
 * total delay, so a continuous stream still produces output periodically.
 */
export function createDebouncer(fn: () => void, opts: DebounceOptions): Debouncer {
  const { wait } = opts;
  const leading = opts.leading ?? false;
  const maxWait = opts.maxWait;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let lastCall = 0;

  function invoke(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
    pending = false;
    fn();
  }

  return {
    schedule() {
      const now = Date.now();
      if (!pending) {
        lastCall = now;
        pending = true;
        if (leading) {
          fn();
          // Leading-edge still needs to cap by wait so a subsequent call during
          // the wait window is deferred.
        }
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(invoke, wait);
      if (maxWait !== undefined && maxTimer === undefined) {
        const elapsed = now - lastCall;
        maxTimer = setTimeout(invoke, Math.max(0, maxWait - elapsed));
      }
    },
    flush() {
      if (!pending) return;
      invoke();
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (maxTimer !== undefined) {
        clearTimeout(maxTimer);
        maxTimer = undefined;
      }
      pending = false;
    },
    get isPending() {
      return pending;
    },
  };
}
