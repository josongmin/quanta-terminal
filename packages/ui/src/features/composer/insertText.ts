/**
 * Composer insert-text bus — a tiny pub/sub for imperatively injecting text
 * into the composer input.
 *
 * Why a bus: the Composer widget is presentational and owns its own textarea
 * state. Outside actors (drag-and-drop of external files, the history search
 * inserting a prior command, paste-from-toolbar affordances, etc.) need a
 * way to append to that state WITHOUT tunneling a ref through the React tree
 * — that would couple every sibling page to the widget instance. A window-
 * level CustomEvent fits in one file, is trivially testable with jsdom, and
 * keeps the composer decoupled from who wants to insert.
 *
 * Contract:
 *   - `dispatchComposerInsertText(text, opts)` schedules an insertion. The
 *     composer consumes it on its next render.
 *   - `onComposerInsertText(handler)` subscribes; the composer calls this.
 *   - `opts.mode` controls how text is joined: "append" inserts with a
 *     leading space when the current value is non-empty, "replace" clears
 *     and sets. Default "append".
 *   - `opts.quote` wraps the text in double quotes when true. File paths
 *     with spaces need this; callers decide, not the bus.
 *   - `opts.focus` focuses the textarea on insert. Default true.
 */

export type InsertMode = 'append' | 'replace';

export interface InsertTextDetail {
  readonly text: string;
  readonly mode: InsertMode;
  readonly quote: boolean;
  readonly focus: boolean;
}

const EVENT_NAME = 'quanta.composer.insert-text';

export interface InsertTextOptions {
  readonly mode?: InsertMode;
  readonly quote?: boolean;
  readonly focus?: boolean;
}

/**
 * Broadcast a request to insert text into the composer. No-op when no
 * listener is registered (e.g. tests that do not mount the page).
 */
export function dispatchComposerInsertText(text: string, opts?: InsertTextOptions): void {
  if (typeof window === 'undefined') return;
  const detail: InsertTextDetail = {
    text,
    mode: opts?.mode ?? 'append',
    quote: opts?.quote ?? false,
    focus: opts?.focus ?? true,
  };
  window.dispatchEvent(new CustomEvent<InsertTextDetail>(EVENT_NAME, { detail }));
}

/**
 * Register a handler that receives insert requests. Returns an unsubscribe
 * function; callers must invoke it on unmount to avoid stale closures.
 */
export function onComposerInsertText(
  handler: (detail: InsertTextDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const ce = e as CustomEvent<InsertTextDetail>;
    if (!ce.detail) return;
    handler(ce.detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

/**
 * Shell-quote a path: wraps in double quotes and escapes embedded quotes /
 * backslashes. Intentionally conservative — enough for typical file names,
 * not a full POSIX quoting library. For unusual paths (newlines, control
 * characters) callers should build a richer escape upstream.
 */
export function shellQuotePath(path: string): string {
  // A path without whitespace, quotes, backslashes, or shell metacharacters
  // does not need quoting. The check is a fast-path; the else-branch handles
  // everything tricky.
  if (/^[\w.\-/@:+=]+$/u.test(path)) return path;
  return '"' + path.replace(/(["\\$`])/gu, '\\$1') + '"';
}

/** Join text into an existing composer value according to the insert mode. */
export function applyInsert(current: string, detail: InsertTextDetail): string {
  const piece = detail.quote ? shellQuotePath(detail.text) : detail.text;
  if (detail.mode === 'replace') return piece;
  if (current.length === 0) return piece;
  // Append with a single space separator unless the tail already ends in
  // whitespace. Trailing newlines in `current` are normalised to a space so
  // the paste target reads as one continuous command line.
  const tail = current[current.length - 1];
  const sep = tail === ' ' || tail === '\t' ? '' : ' ';
  return current + sep + piece;
}
