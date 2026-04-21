/**
 * `.qrpl` journal format — TypeScript reader.
 *
 * Companion to `packages/host-tauri/src-tauri/src/session_record.rs`, which
 * owns the writer. The two MUST stay in lockstep: every field written there
 * is consumed here in the same order, little-endian. A drift between the two
 * is caught by the `bridge-conformance` integration test on CI.
 *
 * The `.qrpl` layout is:
 *
 * ```text
 *  Header (512 B fixed) — see readHeader()
 *  +--------------------+
 *  |  magic "QRPL\0\0\0\0" |  8 B
 *  |  version u32 LE    |  4 B
 *  |  cols u32 LE       |  4 B
 *  |  rows u32 LE       |  4 B
 *  |  createdAt i64 LE  |  8 B   (ms since Unix epoch)
 *  |  shell [u8;32]     | 32 B   (null-padded)
 *  |  cwd [u8;256]      |256 B   (null-padded)
 *  |  (reserved zero)   |196 B
 *  +--------------------+
 *  Frames — repeating, streamed:
 *  +--------------------+
 *  |  magic "FR"        |  2 B
 *  |  ts u32 LE (rel ms)|  4 B
 *  |  chunkLen u32 LE   |  4 B
 *  |  payload bytes     |  chunkLen B
 *  +--------------------+
 * ```
 *
 * Why TS owns the reader: the replay engine lives on the UI side (the
 * `VtEmulator` is TS), and every byte read here flows directly into
 * `emulator.feed`. A round-trip through a Rust reader and back across IPC
 * would triple the memory cost and complicate streaming. The Rust side still
 * has its own reader (exposed in `session_record.rs` for tests + a future
 * sidecar CLI); keeping two implementations is worth the extra scrutiny
 * because the format is tiny and rarely changes.
 */

export const JOURNAL_MAGIC = new Uint8Array([
  0x51, 0x52, 0x50, 0x4c, 0x00, 0x00, 0x00, 0x00,
]); // "QRPL\0\0\0\0"
export const JOURNAL_VERSION = 1;
export const HEADER_LEN = 512;
export const FRAME_MAGIC = new Uint8Array([0x46, 0x52]); // "FR"
export const FRAME_HEADER_LEN = 10; // 2 (magic) + 4 (ts) + 4 (len)
export const MAX_FRAME_PAYLOAD = 64 * 1024 * 1024; // 64 MiB sanity cap

export interface JournalHeader {
  readonly version: number;
  readonly cols: number;
  readonly rows: number;
  readonly createdAtMs: number;
  readonly shell: string;
  readonly cwd: string;
}

export interface JournalFrame {
  /** Milliseconds relative to `createdAtMs`. */
  readonly tsMs: number;
  /** Chunk payload — `Uint8Array` so the replay loop can feed it straight
   *  into `VtEmulator.feed` without a copy. */
  readonly bytes: Uint8Array;
}

export class JournalFormatError extends Error {
  constructor(
    message: string,
    public readonly code: JournalFormatErrorCode,
  ) {
    super(message);
    this.name = 'JournalFormatError';
  }
}

export type JournalFormatErrorCode =
  | 'short_header'
  | 'bad_magic'
  | 'unsupported_version';

/**
 * Parse the first 512 B of a journal file. Rejects short buffers, bad magic
 * (bit flips, wrong file type), and versions beyond what this build knows.
 * Lower-than-current versions are NOT rejected here — we keep a single
 * happy path and let future `upgradeHeader` helpers migrate the shape.
 */
export function readHeader(buf: Uint8Array): JournalHeader {
  if (buf.byteLength < HEADER_LEN) {
    throw new JournalFormatError(
      `journal header short: ${buf.byteLength} < ${HEADER_LEN}`,
      'short_header',
    );
  }
  for (let i = 0; i < JOURNAL_MAGIC.byteLength; i += 1) {
    if (buf[i] !== JOURNAL_MAGIC[i]) {
      throw new JournalFormatError('journal magic mismatch', 'bad_magic');
    }
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(8, true);
  if (version === 0 || version > JOURNAL_VERSION) {
    throw new JournalFormatError(
      `journal version unsupported: ${version} (expected <= ${JOURNAL_VERSION})`,
      'unsupported_version',
    );
  }
  const cols = dv.getUint32(12, true) & 0xffff;
  const rows = dv.getUint32(16, true) & 0xffff;
  // i64 LE. We read as two u32s + BigInt to avoid losing precision on
  // timestamps > 2^53 (past 2255-06-05 on Linux epoch, but we pay the cost
  // anyway for correctness).
  const low = dv.getUint32(20, true);
  const high = dv.getUint32(24, true);
  const createdAtMs = Number((BigInt(high) << 32n) | BigInt(low));
  const shell = readCstr(buf, 28, 32);
  const cwd = readCstr(buf, 60, 256);
  return { version, cols, rows, createdAtMs, shell, cwd };
}

function readCstr(buf: Uint8Array, offset: number, width: number): string {
  const end = Math.min(offset + width, buf.byteLength);
  let term = end;
  for (let i = offset; i < end; i += 1) {
    if (buf[i] === 0) {
      term = i;
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(
    buf.subarray(offset, term),
  );
}

/**
 * Iterate frame records from a buffer containing the post-header bytes.
 *
 * Short tails (truncated writes from a SIGKILL'd writer) terminate the
 * iteration gracefully — the caller treats "no more frames" and "short tail"
 * identically, which matches the writer's contract that any fully-written
 * frame must be replayable.
 *
 * Corrupt middle frames (bad FRAME_MAGIC, or chunkLen > MAX_FRAME_PAYLOAD)
 * are also terminal: we stop iterating, so a bit flip in the tail truncates
 * replay to the last known-good prefix rather than poisoning the emulator.
 */
export function* iterFrames(body: Uint8Array): Generator<JournalFrame> {
  let off = 0;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  while (off + FRAME_HEADER_LEN <= body.byteLength) {
    if (body[off] !== FRAME_MAGIC[0] || body[off + 1] !== FRAME_MAGIC[1]) {
      return; // corrupt — stop replay at this boundary
    }
    const tsMs = dv.getUint32(off + 2, true);
    const chunkLen = dv.getUint32(off + 6, true);
    if (chunkLen > MAX_FRAME_PAYLOAD) return;
    const payloadStart = off + FRAME_HEADER_LEN;
    const payloadEnd = payloadStart + chunkLen;
    if (payloadEnd > body.byteLength) return; // short tail
    yield {
      tsMs,
      // Copy into a standalone Uint8Array so the caller can retain it past
      // the generator's lifetime without holding a reference to the whole
      // file buffer. Empty-frame case is preserved as a zero-length array.
      bytes: body.slice(payloadStart, payloadEnd),
    };
    off = payloadEnd;
  }
}

/**
 * Count frames + total payload bytes without materialising them. Used by
 * the storm-fallback heuristic to decide "is this journal worth replaying
 * within the 500 ms budget?" before the expensive VtEmulator feed loop.
 */
export function summariseFrames(body: Uint8Array): {
  frames: number;
  payloadBytes: number;
} {
  let frames = 0;
  let payloadBytes = 0;
  for (const f of iterFrames(body)) {
    frames += 1;
    payloadBytes += f.bytes.byteLength;
  }
  return { frames, payloadBytes };
}
