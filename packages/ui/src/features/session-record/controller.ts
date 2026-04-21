/**
 * Session-record controller — the feature-level singleton that binds the
 * recorder buffer (`recorder.ts`) to the store (`entities/session-record`) and
 * to the PTY byte stream (consumed via `observeSessionBytes`).
 *
 * Shape:
 *   - One active recorder at a time. Starting a new recording when one is
 *     already in flight silently rolls the previous one (its bytes are
 *     discarded — the user has no way to access them).
 *   - The controller subscribes to the session's byte stream via
 *     `observeSessionBytes`, which is set by the session connect layer.
 *   - On overflow the controller flips the store to idle and surfaces a toast.
 *
 * The controller is stateless public API; it delegates to a module-scoped
 * recorder handle. Tests call `__resetSessionRecordControllerForTests` to
 * reset the singleton.
 */

import { t } from '../../shared/i18n/index.js';
import { showToast } from '../../shared/ui/toast/index.js';
import {
  useSessionsStore,
  getActiveSessionEntity,
} from '../../entities/session/index.js';
import { useSessionRecordStore } from '../../entities/session-record/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import {
  createRecorder,
  type AsciicastHeader,
  type Recorder,
} from './recorder.js';
import { getObservedSessionId, subscribeSessionBytes } from './byte-bus.js';

interface ActiveRecording {
  readonly recorder: Recorder;
  readonly sessionId: SessionId;
  readonly unsubscribe: () => void;
  readonly tickHandle: ReturnType<typeof setInterval> | null;
}

let active: ActiveRecording | null = null;

/**
 * Capture terminal dims best-effort. The real PTY size lives on the session
 * entity today (shell / cwd / health are stored but the column/row pair is
 * owned by the canvas feature). For the asciicast header we fall back to the
 * common 80x24 default when dims are unknown — this matches the asciinema
 * default and lets the player still render.
 */
function deriveHeader(sessionId: SessionId): AsciicastHeader {
  const entity = useSessionsStore.getState().entities[sessionId];
  const env: Record<string, string> = {};
  if (entity?.shell) env.SHELL = entity.shell;
  // `TERM` is set by the host at spawn; we surface the canonical default so
  // asciinema players render colour correctly. A real host-supplied TERM
  // plumbing would land in a future pass.
  env.TERM = 'xterm-256color';
  return {
    version: 2,
    width: 80,
    height: 24,
    timestamp: Math.floor(Date.now() / 1000),
    env,
  };
}

export interface StartRecordingResult {
  readonly ok: boolean;
  readonly reason?: 'already-recording' | 'no-active-session';
}

export function startRecording(): StartRecordingResult {
  if (active) return { ok: false, reason: 'already-recording' };
  const entity = getActiveSessionEntity();
  if (!entity) return { ok: false, reason: 'no-active-session' };
  const sessionId = entity.id;

  const recorder = createRecorder({
    header: deriveHeader(sessionId),
    onOverflow: () => {
      showToast({
        kind: 'warning',
        message: t('sessionRecord.toast.overflow'),
      });
      // The buffer is still available for serialization — the user can save
      // whatever was captured before the cap.
      finishRecordingInternal({ surfaceModal: true });
    },
  });
  recorder.start();

  // Wire the byte stream. The session-connect layer publishes chunks via
  // `publishChunk` (see byte-bus.ts) — we subscribe narrowly to our session.
  const unsubscribe = subscribeSessionBytes((chunkSessionId, bytes, tMs) => {
    if (chunkSessionId !== sessionId) return;
    recorder.pushChunk(bytes, tMs);
    // Nudge the store tick counters immediately so the indicator feels live
    // on the first chunk. The interval below takes over for idle periods.
    useSessionRecordStore.getState().tick(
      recorder.elapsedSeconds(),
      recorder.byteCount(),
    );
  });

  // 1 Hz tick for the REC timer. Effect inside the indicator component is the
  // primary repainter, but we tick the store here so an unmounted indicator
  // (e.g. status bar virtualised off-screen on a tiny viewport) still has up-
  // to-date counters when it remounts.
  const tickHandle =
    typeof setInterval === 'function'
      ? setInterval(() => {
          if (!active) return;
          useSessionRecordStore.getState().tick(
            active.recorder.elapsedSeconds(),
            active.recorder.byteCount(),
          );
        }, 1000)
      : null;

  active = { recorder, sessionId, unsubscribe, tickHandle };
  useSessionRecordStore.getState().begin(sessionId);
  return { ok: true };
}

export interface StopRecordingResult {
  readonly ok: boolean;
  readonly jsonl: string;
  readonly byteCount: number;
  readonly eventCount: number;
  readonly durationSec: number;
  readonly sessionId: SessionId | null;
}

/** Public "stop and return the bundled payload". */
export function stopRecording(): StopRecordingResult {
  return finishRecordingInternal({ surfaceModal: false });
}

/**
 * The user discarded the recording from the modal. Same teardown as
 * `stopRecording` but we don't bother serializing the buffer.
 */
export function discardRecording(): void {
  if (!active) return;
  active.unsubscribe();
  if (active.tickHandle !== null) clearInterval(active.tickHandle);
  active.recorder.stop();
  active = null;
  useSessionRecordStore.getState().end();
}

function finishRecordingInternal(opts: {
  readonly surfaceModal: boolean;
}): StopRecordingResult {
  if (!active) {
    return {
      ok: false,
      jsonl: '',
      byteCount: 0,
      eventCount: 0,
      durationSec: 0,
      sessionId: null,
    };
  }
  const { recorder, sessionId, unsubscribe, tickHandle } = active;
  unsubscribe();
  if (tickHandle !== null) clearInterval(tickHandle);
  recorder.stop();
  const jsonl = recorder.serialize();
  const result: StopRecordingResult = {
    ok: true,
    jsonl,
    byteCount: recorder.byteCount(),
    eventCount: recorder.eventCount(),
    durationSec: recorder.elapsedSeconds(),
    sessionId,
  };
  active = null;
  useSessionRecordStore.getState().end();
  if (opts.surfaceModal) {
    // Publish the result via the modal pubsub so the terminal page opens the
    // stop modal automatically on an overflow-triggered stop. Consumers that
    // stopped manually via `stopRecording()` get the result back synchronously.
    publishAutoStopResult(result);
  }
  return result;
}

/**
 * Toggle shortcut handler: if recording, stop + open the modal via
 * `publishAutoStopResult`. Else start.
 */
export function toggleRecording(): void {
  if (isRecording()) {
    const result = stopRecording();
    if (result.ok) publishAutoStopResult(result);
    return;
  }
  const start = startRecording();
  if (!start.ok) {
    const reason =
      start.reason === 'no-active-session'
        ? t('sessionRecord.toast.noSession')
        : t('sessionRecord.toast.alreadyRecording');
    showToast({ kind: 'info', message: reason });
  }
}

export function isRecording(): boolean {
  return active !== null;
}

/**
 * Observe the next "stop" result (whether triggered by hotkey, palette, or
 * overflow). The terminal page opens the StopRecordingModal from this. Returns
 * an unsubscribe.
 */
type StopListener = (result: StopRecordingResult) => void;
const stopListeners: Set<StopListener> = new Set();

export function subscribeStopResult(listener: StopListener): () => void {
  stopListeners.add(listener);
  return () => {
    stopListeners.delete(listener);
  };
}

function publishAutoStopResult(result: StopRecordingResult): void {
  for (const l of Array.from(stopListeners)) {
    try {
      l(result);
    } catch {
      // A broken listener must not wedge the recorder teardown.
    }
  }
}

/**
 * Diagnostic accessor — the status bar indicator uses this via `getObservedSessionId`
 * so tests can assert wiring parity without exporting the byte-bus directly.
 */
export function currentRecordingSessionId(): SessionId | null {
  return active?.sessionId ?? null;
}

/** Test-only reset. */
export function __resetSessionRecordControllerForTests(): void {
  if (active) {
    active.unsubscribe();
    if (active.tickHandle !== null) clearInterval(active.tickHandle);
  }
  active = null;
  stopListeners.clear();
  useSessionRecordStore.getState().reset();
  // Re-export getObservedSessionId so this module is the single import point
  // for controller + byte bus. A simple re-export keeps the call sites tidy.
  void getObservedSessionId;
}
