/**
 * Asciicast v2 session recorder.
 *
 * This module owns the serializer and the in-memory event buffer for a single
 * recording. It is intentionally framework-free: no zustand, no React, no host
 * bridge. Wiring to the session byte stream, the UI indicator, and the
 * command-palette commands lives in sibling modules so the recorder itself is
 * trivially unit-testable.
 *
 * Format
 * ------
 * Asciicast v2 (https://github.com/asciinema/asciinema/blob/develop/doc/asciicast-v2.md):
 *
 *   Line 0: JSON header
 *     {"version": 2, "width": 80, "height": 24, "timestamp": 1719000000,
 *      "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"}}
 *
 *   Line 1..N: JSON array `[elapsed_seconds, "o", "payload"]`
 *
 * The recorder only emits "o" (output) events in this pass — input capture and
 * pause/resume are explicitly out of scope.
 *
 * Safety cap
 * ----------
 * A 32 MiB cap on accumulated UTF-8 payload bytes stops a runaway process or
 * a `cat /dev/urandom` from eating host memory. When we trip the cap the
 * recorder flips `overflow = true`, stops accepting new chunks, and the caller
 * (the session-record feature) surfaces a toast via `onOverflow`.
 */

export interface AsciicastHeader {
  readonly version: 2;
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly title?: string;
}

export interface CreateRecorderOptions {
  readonly header: AsciicastHeader;
  /**
   * Optional monotonic clock source. Tests inject a deterministic clock; prod
   * uses `Date.now()`. Returned value MUST be in milliseconds.
   */
  readonly now?: () => number;
  /** Maximum buffered payload bytes before the recorder bails out. */
  readonly maxBytes?: number;
  /** Called once when the buffer cap is tripped. */
  readonly onOverflow?: () => void;
}

export interface Recorder {
  start(): void;
  stop(): void;
  isRecording(): boolean;
  /**
   * Append an output chunk. `bytes` may be a `Uint8Array` (PTY-native) or a
   * string (already-decoded). `tMs` is a wall-clock ms timestamp sourced by
   * the caller — the recorder subtracts the start time to get elapsed seconds.
   *
   * Returns `false` when the chunk was dropped (recorder not running, or the
   * buffer cap has been tripped).
   */
  pushChunk(bytes: Uint8Array | string, tMs: number): boolean;
  /** Header bytes + JSONL event lines as a single string. */
  serialize(): string;
  /** Count of pushed events (excludes overflow-dropped ones). */
  eventCount(): number;
  /** Total payload bytes captured so far. */
  byteCount(): number;
  /** Current wall-time duration in seconds (0 when not started). */
  elapsedSeconds(now?: number): number;
  /** Captured start timestamp (ms). 0 before start(). */
  startedAtMs(): number;
}

/** 32 MiB cap — matches the RFC for this feature. */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

const DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function decodeBytes(bytes: Uint8Array): string {
  if (DECODER) return DECODER.decode(bytes);
  // Fallback for pathological test environments without TextDecoder: treat
  // bytes as latin-1. Real hosts always have TextDecoder.
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Utility: byte length of a UTF-8 encoded string. We use this to grow the
 * buffer cap counter for string payloads (PTY decoded-on-arrival paths)
 * without re-encoding.
 */
function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // Fallback — over-estimates high code points but never under-counts so the
  // cap still holds.
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else n += 3;
  }
  return n;
}

/**
 * Serialize an elapsed-seconds number to 6 decimals. We avoid
 * `Number.prototype.toFixed` for very large values because it renders in
 * fixed-notation regardless — which is actually what asciicast wants — so it
 * is the right primitive here. Edge-case: `toFixed(6)` on `0.0000001` returns
 * `"0.000000"` which is fine; the player reads consecutive events by their
 * relative order, not by exact equality.
 */
function formatSeconds(elapsedMs: number): string {
  const sec = Math.max(0, elapsedMs) / 1000;
  return sec.toFixed(6);
}

type Event = readonly [number, 'o', string];

export function createRecorder(opts: CreateRecorderOptions): Recorder {
  const { header } = opts;
  const clock = opts.now ?? (() => Date.now());
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let recording = false;
  let startedAt = 0;
  let bytes = 0;
  let overflow = false;
  const events: Event[] = [];

  function assertHeader(): void {
    if (header.version !== 2) throw new Error('recorder: header.version must be 2');
    if (!Number.isFinite(header.width) || header.width <= 0) {
      throw new Error('recorder: header.width must be a positive finite number');
    }
    if (!Number.isFinite(header.height) || header.height <= 0) {
      throw new Error('recorder: header.height must be a positive finite number');
    }
  }
  assertHeader();

  return {
    start(): void {
      if (recording) return;
      recording = true;
      startedAt = clock();
      // Do NOT clear `events` here — the typical UX is start → pushChunk → stop
      // → serialize → (optionally) discard. A second start() after stop() is
      // a fresh recording; we reset then.
      events.length = 0;
      bytes = 0;
      overflow = false;
    },

    stop(): void {
      recording = false;
    },

    isRecording(): boolean {
      return recording;
    },

    pushChunk(input, tMs): boolean {
      if (!recording) return false;
      if (overflow) return false;
      const text = typeof input === 'string' ? input : decodeBytes(input);
      if (text.length === 0) return true;
      const chunkBytes = typeof input === 'string' ? utf8ByteLength(text) : input.byteLength;
      if (bytes + chunkBytes > maxBytes) {
        overflow = true;
        recording = false;
        opts.onOverflow?.();
        return false;
      }
      bytes += chunkBytes;
      const elapsedMs = Math.max(0, tMs - startedAt);
      events.push([elapsedMs, 'o', text] as const);
      return true;
    },

    serialize(): string {
      // Header: strip undefined optionals so the JSON stays clean (asciinema
      // parsers accept extra fields but the canonical shape has no `title` /
      // `env` key when absent).
      const headerJson = JSON.stringify(stripUndefined(header));
      if (events.length === 0) return headerJson + '\n';
      const lines: string[] = [headerJson];
      for (const [elapsedMs, kind, payload] of events) {
        // The asciicast v2 frame is `[seconds, "o", payload]`. `JSON.stringify`
        // quotes the array itself — we assemble it piecewise so the seconds
        // field renders as a bare number rather than a string.
        lines.push(`[${formatSeconds(elapsedMs)}, ${JSON.stringify(kind)}, ${JSON.stringify(payload)}]`);
      }
      return lines.join('\n') + '\n';
    },

    eventCount(): number {
      return events.length;
    },

    byteCount(): number {
      return bytes;
    },

    elapsedSeconds(now?: number): number {
      if (!recording && startedAt === 0) return 0;
      const endMs = now ?? clock();
      return Math.max(0, endMs - startedAt) / 1000;
    },

    startedAtMs(): number {
      return startedAt;
    },
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as Array<[keyof T, T[keyof T]]>) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Suggest a filename in the asciinema convention. Uses an ISO-ish compact
 * form (`YYYYMMDDTHHMMSS`) so filenames sort naturally and don't carry
 * filesystem-hostile colons.
 */
export function suggestCastFilename(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `quanta-${stamp}.cast`;
}
