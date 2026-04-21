/**
 * `useOutputAnnouncer` — subscribe the live-region writer to block output.
 *
 * The hook observes the currently-active block's `outputChunks`, diffs against
 * what it has already announced, runs the new bytes through `stripAnsi`, and
 * exposes a debounced "next thing to speak" string to consumers (the LiveRegion
 * writes it into an `aria-live` container).
 *
 * Why this shape, not a subscription in the LiveRegion
 * ----------------------------------------------------
 * The live region is a dumb sink — all of the policy lives here so it can be
 * exercised in a unit test without the DOM:
 *
 *   - Batching      : 250 ms debounce so a gush of chunked bytes becomes one
 *                     utterance rather than 40 micro-utterances that race the
 *                     screen reader's tokenizer.
 *   - Throttling    : if the queue ever grows past 10 lines, keep only the
 *                     newest 10 (screen readers can't keep up with floods;
 *                     dropping stale progress-bar lines is the right tradeoff).
 *   - De-dup        : progress bars frequently re-emit the same line (e.g.
 *                     `npm install` printing the same rotator); identical
 *                     consecutive lines collapse to one announcement.
 *   - Truncation    : any single line longer than 200 chars is truncated with
 *                     an ellipsis so the reader doesn't read a 10 MB JSON
 *                     blob character-by-character.
 *   - Policy gates  : during alt-screen / TUI mode OR while a password prompt
 *                     is the most-recent signal for the active block, we
 *                     emit nothing. The `prefers-reduced-data` query flips
 *                     nothing functional (aria-live has no data cost), but
 *                     we read it for parity with the rest of the a11y
 *                     plumbing so future consumers stay consistent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBlockStore, concatChunks, type BlockState } from '../../entities/block/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { stripAnsi } from '../../shared/lib/ansi-parser/strip.js';
import { detectPasswordPrompt, tailLines } from '../secret-detect/index.js';
import {
  useA11yAnnounceSettings,
  resolveEffectiveAnnounceMode,
  type A11yAnnounceMode,
} from './settings.js';

export const ANNOUNCE_DEBOUNCE_MS = 250;
export const ANNOUNCE_LINE_MAX_CHARS = 200;
export const ANNOUNCE_QUEUE_MAX_LINES = 10;

export interface UseOutputAnnouncerResult {
  /** The live politeness level, resolved through the enable gate. */
  readonly mode: A11yAnnounceMode;
  /** Current utterance string (what the live region should show). */
  readonly message: string;
}

interface PerBlockCursor {
  /** chunkCount consumed so far — subsequent chunks become new bytes. */
  consumedChunks: number;
  /** The last fully-emitted line, for run-length de-dup at the boundary. */
  lastAnnouncedLine: string;
  /** Unfinished tail from the previous chunk (no newline yet). */
  partial: string;
  /**
   * When `true`, the active line we're building is a truncation-continuation
   * that we've already emitted "…" for. Subsequent bytes on the same logical
   * line are dropped until we see a newline.
   */
  truncating: boolean;
}

/**
 * Pure helper: given previous cursor + fresh raw text (ANSI-stripped), yield
 * the list of new LINES to announce and the updated cursor. Exposed separately
 * for unit tests — the hook below simply arranges the inputs.
 */
export function extractAnnouncementLines(
  prev: PerBlockCursor,
  freshText: string,
): { readonly lines: readonly string[]; readonly cursor: PerBlockCursor } {
  const combined = prev.partial + freshText;
  const out: string[] = [];
  let partial = '';
  let truncating = prev.truncating;
  let lastAnnounced = prev.lastAnnouncedLine;

  // Split on \n; keep a trailing "" as the next partial.
  const pieces = combined.split('\n');
  for (let i = 0; i < pieces.length; i += 1) {
    const isLast = i === pieces.length - 1;
    let piece = pieces[i] ?? '';
    // Normalize \r-overwrite: screen readers treat \r as noise. Keep only
    // the segment AFTER the last \r in the line so progress bars (which
    // rewrite the same line repeatedly between newlines) announce their
    // final committed state rather than every overwrite.
    const crIdx = piece.lastIndexOf('\r');
    if (crIdx >= 0) piece = piece.slice(crIdx + 1);
    piece = piece.replace(/\s+$/u, '');
    if (isLast) {
      // No terminating newline yet — stash as partial for the next pass.
      partial = piece;
      continue;
    }
    // A completed line: apply truncation, de-dup, emit.
    if (truncating) {
      // We already emitted "…" for this logical line; the newline resets
      // the truncation state without emitting anything more.
      truncating = false;
      continue;
    }
    let line = piece;
    if (line.length > ANNOUNCE_LINE_MAX_CHARS) {
      line = line.slice(0, ANNOUNCE_LINE_MAX_CHARS - 1) + '…';
    }
    if (line.length === 0) continue;
    if (line === lastAnnounced) continue;
    out.push(line);
    lastAnnounced = line;
  }

  // If the PENDING partial overshoots the per-line cap, emit the truncated
  // prefix now and mark truncation so the rest of the line is dropped.
  if (partial.length > ANNOUNCE_LINE_MAX_CHARS) {
    const truncated = partial.slice(0, ANNOUNCE_LINE_MAX_CHARS - 1) + '…';
    if (truncated !== lastAnnounced) {
      out.push(truncated);
      lastAnnounced = truncated;
    }
    truncating = true;
    partial = '';
  }

  return {
    lines: out,
    cursor: {
      consumedChunks: prev.consumedChunks,
      lastAnnouncedLine: lastAnnounced,
      partial,
      truncating,
    },
  };
}

function emptyCursor(): PerBlockCursor {
  return {
    consumedChunks: 0,
    lastAnnouncedLine: '',
    partial: '',
    truncating: false,
  };
}

/**
 * Collapse a pending line queue to obey the throttle cap. We keep only the
 * tail so an overwhelmed reader hears the MOST RECENT lines — older progress
 * updates are stale by the time the next utterance starts anyway.
 */
function applyQueueCap(queue: readonly string[]): readonly string[] {
  if (queue.length <= ANNOUNCE_QUEUE_MAX_LINES) return queue;
  return queue.slice(queue.length - ANNOUNCE_QUEUE_MAX_LINES);
}

/**
 * Find the block that represents "current terminal output". We prefer the
 * store's `activeBlockId` (the running block). When nothing is running we
 * fall back to the last-appended block in `order` — that's what the user is
 * looking at after a completed command and its output is still the right
 * thing to announce if the user just ran, say, `cat README.md` and moved
 * focus away.
 */
function pickBlockId(state: BlockState): string | null {
  if (state.activeBlockId !== null) return state.activeBlockId;
  const { order } = state;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    if (id !== undefined) return id;
  }
  return null;
}

/**
 * Hook entry. Returns `{ mode, message }`. `message` is updated on the 250 ms
 * debounce. When the feature is off / suppressed, `message` is the empty
 * string and `mode` is `'off'` so consumers can render an inert node.
 */
export function useOutputAnnouncer(): UseOutputAnnouncerResult {
  // Narrow selectors so this hook doesn't over-subscribe. The settings read
  // is two primitives; combining them in an object requires `useShallow` so
  // React 18's `useSyncExternalStore` sees stable references.
  const enabled = useA11yAnnounceSettings((s) => s.enabled);
  const mode = useA11yAnnounceSettings((s) => s.mode);
  const effectiveMode = resolveEffectiveAnnounceMode({ enabled, mode });

  // Re-render when the relevant block shape changes (active id, chunk count).
  const tick = useBlockStore(
    useShallow((s: BlockState) => {
      const id = pickBlockId(s);
      const b = id !== null ? s.entities[id] : undefined;
      return { id, n: b ? b.outputChunks.length : 0, status: b?.status ?? null };
    }),
  );
  const tuiActive = useTuiStore((s) => s.active);

  const cursorRef = useRef<Map<string, PerBlockCursor>>(new Map());
  const queueRef = useRef<readonly string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [message, setMessage] = useState('');

  useEffect(() => {
    // Short-circuit when disabled. We do NOT clear the queue here because a
    // later re-enable should still start with a clean slate — we clear on
    // mode-off explicitly below.
    if (effectiveMode === 'off') {
      queueRef.current = [];
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setMessage('');
      return;
    }
    // Suppress during alt-screen / TUI mode. The grid mutates at cell
    // granularity; feeding that to a screen reader is noise.
    if (tuiActive) return;

    const id = tick.id;
    if (id === null) return;

    const state = useBlockStore.getState();
    const block = state.entities[id];
    if (!block) return;

    // Password-prompt gate: if the tail of this block's output looks like a
    // password prompt, we must not announce anything for the block until the
    // prompt clears. Conservative: compute against the full output tail.
    const allBytes = concatChunks(block.outputChunks);
    const allText = stripAnsi(new TextDecoder().decode(allBytes));
    const tail = tailLines(allText, 4);
    if (detectPasswordPrompt(tail) !== null) return;

    let cursor = cursorRef.current.get(id);
    if (!cursor) {
      cursor = emptyCursor();
      cursorRef.current.set(id, cursor);
    }

    // Take ONLY the new chunks since last pass.
    if (block.outputChunks.length <= cursor.consumedChunks) return;
    const fresh = block.outputChunks.slice(cursor.consumedChunks);
    const freshBytes = concatChunks(fresh);
    const freshText = stripAnsi(new TextDecoder().decode(freshBytes));

    const { lines, cursor: nextCursor } = extractAnnouncementLines(cursor, freshText);
    nextCursor.consumedChunks = block.outputChunks.length;
    cursorRef.current.set(id, nextCursor);

    if (lines.length === 0) return;

    queueRef.current = applyQueueCap([...queueRef.current, ...lines]);

    // Debounce: reset the timer; fire once after the quiet window.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = queueRef.current;
      if (pending.length === 0) return;
      queueRef.current = [];
      setMessage(pending.join('. '));
    }, ANNOUNCE_DEBOUNCE_MS);
  }, [tick.id, tick.n, tick.status, tuiActive, effectiveMode]);

  // Unmount cleanup: drop timers. We intentionally do not clear cursors on
  // block change — the map is small, and preserving cursors keeps a
  // back-and-forth between blocks idempotent.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return useMemo(() => ({ mode: effectiveMode, message }), [effectiveMode, message]);
}
