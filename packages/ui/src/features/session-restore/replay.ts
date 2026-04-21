/**
 * Session-restore replay engine (Plan 0005 P1-E).
 *
 * Given a session id, load every `.qrpl` file on disk for that session and
 * deterministically replay the captured PTY bytes through a fresh
 * `VtEmulator`. The returned emulator is handed to the render surface so
 * the user sees the grid exactly as it was when the previous boot ended —
 * before any live PTY bytes from the fresh shell arrive.
 *
 * # Determinism contract
 *
 * `VtEmulator.feed` is pure wrt its input bytes — no wall-clock reads, no
 * async, no RNG. Given the same construction options and the same byte
 * stream, two emulators produce bit-identical grid state. Replay exploits
 * this by feeding the journal payloads in order; the resulting grid is
 * indistinguishable from what the original emulator produced live.
 *
 * # Storm fallback
 *
 * Replay is bounded by two budgets:
 *
 *   * **Time.** If replay exceeds `storm.timeBudgetMs` (default 500 ms) we
 *     abort and surface `playedFrames < total` to the caller. The partial
 *     grid is still usable — it's exactly what live replay would have
 *     produced at the cutoff point.
 *   * **Size.** If the aggregated journal payload exceeds
 *     `storm.sizeBudgetBytes` (default 10 MiB) we skip replay entirely.
 *     A future P1-E checkpoint substrate will materialise grid snapshots
 *     we can fast-path from; until then the user gets a blank grid instead
 *     of a 30-second boot.
 *
 * Both budgets can be overridden per-call so tests run fast and
 * power-users can opt into longer replays from settings.
 */

import type { SessionId } from '@quanta/host-common';

import { VtEmulator } from '../../shared/lib/vt-emulator/index.js';

import {
  HEADER_LEN,
  type JournalHeader,
  readHeader,
  iterFrames,
  summariseFrames,
  JournalFormatError,
} from './journal-format.js';
import { type JournalPort } from './journal-port.js';

export interface ReplayStormLimits {
  /**
   * Max wall-clock milliseconds the replay loop can spend before bailing
   * out and handing back a partial grid. Default 500 ms (plan 0005 §P1-E).
   */
  readonly timeBudgetMs: number;
  /**
   * If the journal's aggregate payload exceeds this many bytes we skip
   * replay entirely. Default 10 MiB — chosen to match the upper bound of
   * the VtEmulator's feed-per-ms throughput on a mid-range M1.
   */
  readonly sizeBudgetBytes: number;
}

export const DEFAULT_STORM_LIMITS: ReplayStormLimits = {
  timeBudgetMs: 500,
  sizeBudgetBytes: 10 * 1024 * 1024,
};

export interface ReplaySessionOptions {
  /** Port used to load journal bytes. Required — no implicit Tauri fallback. */
  readonly port: JournalPort;
  /**
   * Monotonic clock, injectable so tests can pin the storm-budget cutoff
   * without real timers. Defaults to `performance.now()` when available,
   * `Date.now()` otherwise.
   */
  readonly now?: () => number;
  readonly storm?: Partial<ReplayStormLimits>;
  /**
   * Factory for the replay `VtEmulator`. Tests override this to inject a
   * spy that records every `feed` call. Production callers should leave it
   * unset — we construct a dimensions-matched emulator from the journal
   * header so the grid shape on reload equals the grid shape at capture.
   */
  readonly makeEmulator?: (header: JournalHeader) => VtEmulator;
}

export interface ReplayResult {
  /**
   * The reconstructed emulator. `null` when replay was skipped (no journal,
   * storm-budget blown, or header rejected) — the caller should spawn a
   * blank emulator in that case.
   */
  readonly emulator: VtEmulator | null;
  /** Parsed header — `null` when no journal was loaded. */
  readonly header: JournalHeader | null;
  /** Number of frame payloads fed into the emulator. */
  readonly playedFrames: number;
  /** Total bytes fed (sum of `bytes.byteLength`). */
  readonly playedBytes: number;
  /** Wall-clock ms spent inside the replay loop. */
  readonly elapsedMs: number;
  /** Non-null when replay short-circuited; describes why. */
  readonly fallbackReason: StormFallbackReason | null;
}

export type StormFallbackReason =
  | 'no_journal'
  | 'header_rejected'
  | 'size_budget_exceeded'
  | 'time_budget_exceeded';

/**
 * Load + replay a session journal. Returns the seeded `VtEmulator` ready
 * to be handed to the render surface.
 *
 * This function does NOT touch any global state (no zustand writes, no
 * side-effecting imports). Callers are responsible for installing the
 * returned emulator into their session pipeline.
 */
export async function replaySession(
  sessionId: SessionId,
  options: ReplaySessionOptions,
): Promise<ReplayResult> {
  const storm: ReplayStormLimits = {
    ...DEFAULT_STORM_LIMITS,
    ...(options.storm ?? {}),
  };
  const now = options.now ?? defaultNow;
  const startedAt = now();

  const files = await options.port.loadSessionJournal(sessionId);
  if (files.length === 0) {
    return emptyResult('no_journal', now() - startedAt);
  }

  // Walk files in chronological order (the port contract guarantees it).
  // First file anchors the header: subsequent rotated files carry the same
  // header so we validate once — a header mismatch mid-stream is treated
  // as "corrupt tail" and truncates replay at that boundary.
  let header: JournalHeader | null = null;
  let totalPayloadBytes = 0;
  const bodies: Uint8Array[] = [];
  for (const file of files) {
    try {
      const parsedHeader = readHeader(file);
      if (header === null) {
        header = parsedHeader;
      } else if (
        parsedHeader.version !== header.version ||
        parsedHeader.cols !== header.cols ||
        parsedHeader.rows !== header.rows
      ) {
        // Mid-stream dimension change: stop here. Future P1-E work will
        // either migrate the payload through a resize() in the replay
        // engine or split replay per-header.
        break;
      }
    } catch (err) {
      if (err instanceof JournalFormatError) {
        // Bad first file = give up; bad tail file = stop at this boundary.
        if (header === null) {
          return emptyResult('header_rejected', now() - startedAt);
        }
        break;
      }
      throw err;
    }
    const body = file.subarray(HEADER_LEN);
    const summary = summariseFrames(body);
    totalPayloadBytes += summary.payloadBytes;
    bodies.push(body);
  }

  if (header === null) {
    return emptyResult('header_rejected', now() - startedAt);
  }

  if (totalPayloadBytes > storm.sizeBudgetBytes) {
    return {
      emulator: null,
      header,
      playedFrames: 0,
      playedBytes: 0,
      elapsedMs: now() - startedAt,
      fallbackReason: 'size_budget_exceeded',
    };
  }

  const emulator = (options.makeEmulator ?? defaultMakeEmulator)(header);

  let playedFrames = 0;
  let playedBytes = 0;
  let fallbackReason: StormFallbackReason | null = null;
  for (const body of bodies) {
    for (const frame of iterFrames(body)) {
      if (now() - startedAt >= storm.timeBudgetMs) {
        fallbackReason = 'time_budget_exceeded';
        break;
      }
      if (frame.bytes.byteLength === 0) continue;
      emulator.feed(frame.bytes);
      playedFrames += 1;
      playedBytes += frame.bytes.byteLength;
    }
    if (fallbackReason !== null) break;
  }

  return {
    emulator,
    header,
    playedFrames,
    playedBytes,
    elapsedMs: now() - startedAt,
    fallbackReason,
  };
}

function emptyResult(reason: StormFallbackReason, elapsedMs: number): ReplayResult {
  return {
    emulator: null,
    header: null,
    playedFrames: 0,
    playedBytes: 0,
    elapsedMs,
    fallbackReason: reason,
  };
}

function defaultMakeEmulator(header: JournalHeader): VtEmulator {
  return new VtEmulator({
    cols: Math.max(1, header.cols),
    rows: Math.max(1, header.rows),
    // We intentionally do NOT wire onEnvelope here — the caller (terminal
    // page) re-decorates the emulator with its own grid-mirror plumbing
    // after replay completes. Replay is pure: it mutates the internal grid
    // only. Supplying a no-op listener is required by the `VtEmulator`
    // constructor, so we pass one.
    onEnvelope: () => {
      /* no-op during replay; caller decorates afterwards */
    },
  });
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
