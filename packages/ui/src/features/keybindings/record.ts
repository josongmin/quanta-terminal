/**
 * Keybinding recorder — captures a single keyboard combination from the next
 * `keydown` event and returns its canonical `Shortcut` string
 * (e.g. `'mod+shift+p'`).
 *
 * Rules enforced here — not in `parseShortcut`, which is happy to accept
 * `'k'` or `'a'` standalone:
 *
 *   - Escape cancels (resolves with `null`).
 *   - A combination MUST include at least one modifier (mod/ctrl/alt/shift)
 *     OR be a function key (F1..F24). A bare printable letter is rejected
 *     because it would swallow regular typing everywhere in the app.
 *   - Shift-only combos where the "key" is a printable letter are allowed
 *     (e.g. `shift+a`), because Shift-letter produces a distinct glyph the
 *     user typically intends. Modifier-only presses (just Shift held down)
 *     are ignored — we wait for a real keydown with a non-modifier key.
 *
 * The helper attaches a `keydown` listener at capture phase so it wins over
 * any app-level handler for the duration of the recording. The listener is
 * torn down whether the caller awaits or ignores the returned promise.
 */

/** Modifier keys we filter out when waiting for "a real key". */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'OS',
  'Hyper',
  'Super',
  'Fn',
  'FnLock',
]);

/**
 * True when the given key string names a function key (F1..F24). Function
 * keys are allowed as standalone shortcuts with no modifier.
 */
function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/u.test(key);
}

export interface CaptureResult {
  /** Canonical shortcut string (`'mod+shift+p'`). */
  readonly shortcut: string;
  /** Original keyboard event for callers that want `preventDefault`, etc. */
  readonly event: KeyboardEvent;
}

export interface CaptureOptions {
  /** Where to listen. Defaults to `window`. */
  readonly target?: Window | Document | HTMLElement;
  /** Abort signal — resolves the promise with null when aborted. */
  readonly signal?: AbortSignal;
  /**
   * Auto-timeout in milliseconds. If no key is captured before this elapses,
   * the promise resolves with `null` (same as Escape). Defaults to 10 000 ms.
   * Prevents the promise hanging forever when the OS intercepts a key (e.g.
   * Meta+Tab / Alt+F4) and no `keydown` event reaches the page.
   */
  readonly timeoutMs?: number;
}

/**
 * Canonicalize a `KeyboardEvent` into the `mod+shift+letter` string format
 * that `parseShortcut` understands. Exported for tests — the main export
 * below is the Promise-returning listener.
 *
 * Returns null when the event does not represent a valid app-level shortcut
 * (bare letter without modifier, modifier-only press, Escape).
 */
export function canonicalizeKeyEvent(event: KeyboardEvent): string | null {
  if (event.key === 'Escape') return null;
  if (MODIFIER_KEYS.has(event.key)) return null;

  const hasMeta = event.metaKey;
  const hasCtrl = event.ctrlKey;
  const hasAlt = event.altKey;
  const hasShift = event.shiftKey;
  const hasCoreMod = hasMeta || hasCtrl || hasAlt;

  // Canonicalize the key. `event.key` is layout-aware; lowercase the letter
  // form so `KeyA` on a Shift-held press (`'A'`) and unshifted (`'a'`) both
  // land on `'a'` — the Shift flag carries the distinction.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  const isFn = isFunctionKey(event.key);

  // Reject: bare printable with no modifier (would break typing). Function
  // keys are allowed standalone.
  if (!hasCoreMod && !hasShift && !isFn) return null;
  // Reject: shift-only on a non-letter non-fn key makes no sense as a binding.
  // (Examples: plain Shift+Enter. We allow it — but Shift+` would not be
  // distinguishable from `~` on US layouts. We accept it and let the user see
  // the result; conflict detection handles collisions.)
  // — intentional no-op; rule above already rejects bare letters without ANY
  // modifier.

  const parts: string[] = [];
  // Prefer `mod` over explicit meta/ctrl — the resolved modifier will map
  // correctly per-platform at parse time. We pick `mod` when EITHER meta or
  // ctrl is held (whichever matches the host). This keeps user-recorded
  // shortcuts portable between mac and non-mac machines.
  if (hasMeta || hasCtrl) parts.push('mod');
  if (hasAlt) parts.push('alt');
  if (hasShift) parts.push('shift');
  parts.push(key);

  return parts.join('+');
}

/**
 * Listen for the next keydown and resolve with the canonical shortcut string,
 * or `null` if the user cancels (Escape), presses a rejected combination, or
 * the auto-timeout elapses.
 *
 * The listener calls `preventDefault` + `stopPropagation` on every key event
 * it sees while armed, so app shortcuts don't fire during recording.
 *
 * Bug 4 fix: an auto-timeout (default 10 s) ensures the promise resolves with
 * `null` even when the OS intercepts a key (e.g. Meta+Tab, Alt+F4) and no
 * `keydown` event reaches the page — preventing the promise from hanging
 * indefinitely.
 */
export function captureNextShortcut(
  options: CaptureOptions = {},
): Promise<string | null> {
  const target: EventTarget = options.target ?? (typeof window !== 'undefined' ? window : ({} as EventTarget));
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<string | null>((resolve) => {
    let done = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      target.removeEventListener('keydown', onKeyDown, true);
      options.signal?.removeEventListener('abort', onAbort);
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      resolve(value);
    };
    const onKeyDown = (e: Event): void => {
      const event = e as KeyboardEvent;
      // Always swallow so downstream app shortcuts don't fire while we are
      // armed — even for rejected combinations the user expects a "record
      // mode" feel where no other actions happen.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        finish(null);
        return;
      }
      if (MODIFIER_KEYS.has(event.key)) {
        // Wait for a real key. Do not resolve yet.
        return;
      }
      const canonical = canonicalizeKeyEvent(event);
      if (canonical === null) {
        // Rejected (bare letter). Silently swallow and keep listening so the
        // user can try again without having to reopen the recorder.
        return;
      }
      finish(canonical);
    };
    const onAbort = (): void => finish(null);
    target.addEventListener('keydown', onKeyDown, true);
    if (options.signal) {
      if (options.signal.aborted) {
        finish(null);
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    // Auto-timeout: resolve null if no key is captured within timeoutMs.
    timeoutHandle = setTimeout(() => finish(null), timeoutMs);
  });
}
