/**
 * Alt-screen byte pipeline + subsequence detector.
 *
 * The terminal-shell widget only ever mounts xterm when a TUI application
 * enters alt-screen mode. The page feeds every PTY chunk through
 * `feedAltScreenStream(bytesB64)` — two things happen:
 *
 *   1. A literal byte-subsequence scanner looks for
 *      `ESC[?1049h` / `ESC[?1047h` / `ESC[?47h` (enter) and the matching
 *      `l`-terminated exit sequences. No ANSI parser: this is a fixed-pattern
 *      match with an 8-byte tail buffer so sequences split across chunks are
 *      still detected.
 *   2. While alt-screen is active, the raw chunk bytes are retained (capped)
 *      and forwarded to a subscribed xterm surface. Before any subscriber
 *      attaches, the buffer keeps the most recent bytes since the alt-screen
 *      enter so the first real subscribe flushes the enter sequence into
 *      xterm (otherwise xterm would miss the mode switch and render garbage).
 *
 * The module is intentionally module-local state — no zustand, no context:
 * callers consume a minimal `subscribeNeedsAltScreen()` observable. The hook
 * `useNeedsAltScreen` is a thin `useSyncExternalStore` wrapper for React.
 *
 * CLAUDE.md: not a speculative abstraction — the alt-screen case is the
 * only reason xterm exists in Phase 3. When a fourth mode variant arrives
 * this grows a parameter; we do not promote to a plugin port.
 */

import { useSyncExternalStore } from 'react';

import { base64ToBytes } from '../../shared/lib/base64.js';

/** Byte sequences that enter alt-screen mode. Checked as literal subsequences
 *  against the tail-buffered stream. */
const ALT_SCREEN_ENTER_SEQUENCES: readonly Uint8Array[] = [
  // ESC [ ? 1 0 4 9 h
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]),
  // ESC [ ? 1 0 4 7 h
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x37, 0x68]),
  // ESC [ ? 4 7 h
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x34, 0x37, 0x68]),
];

/** Exit sequences — same patterns with `l` instead of `h`. */
const ALT_SCREEN_EXIT_SEQUENCES: readonly Uint8Array[] = [
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]),
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x37, 0x6c]),
  new Uint8Array([0x1b, 0x5b, 0x3f, 0x34, 0x37, 0x6c]),
];

/** Longest sequence is 8 bytes; keep a tail buffer one byte shorter than the
 *  shortest sequence could possibly overlap (i.e. 7 bytes). */
const TAIL_BUFFER_BYTES = 8;

/** Cap retained bytes while no subscriber is attached. A typical TUI redraw
 *  fits comfortably in 64 KiB; beyond that we drop the oldest bytes. xterm
 *  will just redraw from the latest cursor position. */
const XTERM_RETAIN_CAP_BYTES = 64 * 1024;

// ----- Module state -----

let tail: Uint8Array = new Uint8Array(0);
let needsAltScreen = false;
/** Retained bytes awaiting an xterm subscriber. Reset whenever alt-screen
 *  enters or exits — xterm never needs pre-enter bytes. */
let retainedForXterm: Uint8Array[] = [];
let retainedBytesTotal = 0;
/** The currently-attached xterm byte listener, if any. */
type BytesListener = (chunk: Uint8Array) => void;
let bytesListener: BytesListener | null = null;

type NeedsAltScreenListener = (value: boolean) => void;
const needsAltScreenListeners = new Set<NeedsAltScreenListener>();

function notifyNeedsAltScreen(): void {
  for (const l of needsAltScreenListeners) {
    try {
      l(needsAltScreen);
    } catch (err) {
      // Listener errors must never break the pipeline. Logged at the caller.
      // eslint-disable-next-line no-console
      console.error('[alt-screen-stream] listener threw', err);
    }
  }
}

// ----- Byte-subsequence scanner -----

function indexOfSubsequence(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Scan `joined` (tail + current chunk) for the first alt-screen enter or
 * exit sequence. Returns which kind + the index in `joined`, or undefined
 * when no sequence matches. The sequence that STARTS EARLIEST wins so the
 * caller can process them in emission order.
 */
function scanForAltScreen(
  joined: Uint8Array,
): { kind: 'enter' | 'exit'; start: number; end: number } | undefined {
  let best: { kind: 'enter' | 'exit'; start: number; end: number } | undefined;
  const consider = (kind: 'enter' | 'exit', needle: Uint8Array): void => {
    const idx = indexOfSubsequence(joined, needle);
    if (idx === -1) return;
    if (!best || idx < best.start) {
      best = { kind, start: idx, end: idx + needle.length };
    }
  };
  for (const needle of ALT_SCREEN_ENTER_SEQUENCES) consider('enter', needle);
  for (const needle of ALT_SCREEN_EXIT_SEQUENCES) consider('exit', needle);
  return best;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function trimTail(src: Uint8Array): Uint8Array {
  if (src.length <= TAIL_BUFFER_BYTES) return src;
  return src.slice(src.length - TAIL_BUFFER_BYTES);
}

// ----- xterm byte retention -----

function appendRetained(chunk: Uint8Array): void {
  retainedForXterm.push(chunk);
  retainedBytesTotal += chunk.length;
  while (retainedBytesTotal > XTERM_RETAIN_CAP_BYTES && retainedForXterm.length > 1) {
    const dropped = retainedForXterm.shift();
    if (dropped) retainedBytesTotal -= dropped.length;
  }
}

function clearRetained(): void {
  retainedForXterm = [];
  retainedBytesTotal = 0;
}

// ----- Public surface -----

/**
 * Feed a base64-encoded PTY chunk through the detector + xterm pipeline.
 * Called by `TerminalPage` from the `connectSession.onData` callback.
 */
export function feedAltScreenStream(bytesB64: string): void {
  feedAltScreenStreamBytes(base64ToBytes(bytesB64));
}

/** Raw-bytes entry point — the test path and the b64 wrapper both land here. */
export function feedAltScreenStreamBytes(chunk: Uint8Array): void {
  if (chunk.length === 0) return;

  // Scan across the boundary: join the tail of the previous chunk with the
  // new chunk, run the scanner, and update state for each sequence in
  // emission order. The scanOffset advances past each match so the same
  // byte range can't trigger twice in one chunk.
  const joined = concatBytes(tail, chunk);
  let scanOffset = 0;
  let changed = false;
  let lastMatchEnd = 0;
  while (scanOffset < joined.length) {
    const found = scanForAltScreen(joined.subarray(scanOffset));
    if (!found) break;
    const desired = found.kind === 'enter';
    if (desired !== needsAltScreen) {
      needsAltScreen = desired;
      changed = true;
      // Reset retained buffer on every transition — xterm, when it mounts
      // (or unmounts and remounts), only cares about bytes from the enter
      // onward. Keeping older bytes would replay pre-TUI output into xterm.
      clearRetained();
    }
    scanOffset += found.end;
    lastMatchEnd = scanOffset;
  }

  // Pipe bytes to xterm (or retain) ONLY while alt-screen is currently on.
  // Before enter and after exit, xterm is unmounted — no reason to buffer.
  if (needsAltScreen) {
    if (bytesListener) {
      bytesListener(chunk);
    } else {
      appendRetained(chunk);
    }
  }

  // Preserve only bytes AFTER the last match in the tail — everything up
  // through `lastMatchEnd` has already been consumed by the scanner and
  // re-scanning it next chunk would cause spurious re-fires.
  const residual =
    lastMatchEnd > 0 ? joined.subarray(lastMatchEnd) : joined;
  tail = trimTail(residual);

  if (changed) notifyNeedsAltScreen();
}

/**
 * Subscribe to `needsAltScreen` state. Listener receives the current value
 * on every transition. Returns a dispose function.
 */
export function subscribeNeedsAltScreen(listener: NeedsAltScreenListener): () => void {
  needsAltScreenListeners.add(listener);
  return () => {
    needsAltScreenListeners.delete(listener);
  };
}

/** Snapshot read — React hook uses this for `getSnapshot`. */
export function getNeedsAltScreen(): boolean {
  return needsAltScreen;
}

/**
 * Attach an xterm byte listener. Any bytes retained since the alt-screen
 * enter are flushed synchronously BEFORE returning — so the caller writes
 * the enter sequence + any buffered output before subscribing. Returns a
 * disposer. Only one listener may be attached at a time; a second attach
 * replaces the first (xterm is a singleton surface).
 */
export function attachXtermListener(listener: BytesListener): () => void {
  bytesListener = listener;
  if (retainedForXterm.length > 0) {
    const frames = retainedForXterm;
    clearRetained();
    for (const chunk of frames) {
      try {
        listener(chunk);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[alt-screen-stream] xterm listener threw', err);
      }
    }
  }
  return () => {
    if (bytesListener === listener) bytesListener = null;
  };
}

/** React hook: subscribe to `needsAltScreen` with `useSyncExternalStore`
 *  semantics so concurrent React does not tear. */
export function useNeedsAltScreen(): boolean {
  return useSyncExternalStore(subscribeNeedsAltScreen, getNeedsAltScreen, getNeedsAltScreen);
}

/** Test helper: reset module state between cases. Not part of the prod API. */
export function __resetAltScreenStreamForTests(): void {
  tail = new Uint8Array(0);
  needsAltScreen = false;
  clearRetained();
  bytesListener = null;
  needsAltScreenListeners.clear();
}
