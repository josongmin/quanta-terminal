/**
 * Public surface of the session-restore feature (Plan 0005 P1-E).
 *
 * The feature's one mission is to replay a persisted PTY journal into a
 * fresh `VtEmulator` so the terminal page can display the user's
 * last-known grid state before the freshly-spawned shell has produced a
 * single byte.
 */

export {
  replaySession,
  DEFAULT_STORM_LIMITS,
  type ReplaySessionOptions,
  type ReplayResult,
  type ReplayStormLimits,
  type StormFallbackReason,
} from './replay.js';
export {
  type JournalPort,
  createTauriJournalPort,
  base64ToBytes,
} from './journal-port.js';
export {
  JOURNAL_VERSION,
  HEADER_LEN,
  readHeader,
  iterFrames,
  summariseFrames,
  JournalFormatError,
  type JournalHeader,
  type JournalFrame,
  type JournalFormatErrorCode,
} from './journal-format.js';
