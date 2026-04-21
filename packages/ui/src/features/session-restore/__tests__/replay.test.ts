/**
 * `session-restore/replay.ts` — unit tests.
 *
 * Pairs with the Rust writer in
 * `packages/host-tauri/src-tauri/src/session_record.rs`. The on-disk format
 * is shared, so these tests ALSO exercise
 * `packages/ui/src/features/session-restore/journal-format.ts`.
 *
 * Covered scenarios (10 cases):
 *   1. Header round-trip via the TS writer helper (bytes match what the
 *      Rust writer emits).
 *   2. Frame round-trip: writer → reader → byte-exact replay into a spy
 *      emulator.
 *   3. Missing journal → `no_journal` fallback, null emulator.
 *   4. Bad magic → `header_rejected` fallback.
 *   5. Unsupported version → `header_rejected` fallback.
 *   6. Short-tail frame (truncated payload) is skipped without throwing.
 *   7. Corrupt middle frame (bad FR magic) truncates replay cleanly.
 *   8. Storm fallback: payload > size budget → `size_budget_exceeded`.
 *   9. Storm fallback: wall-clock > time budget → `time_budget_exceeded`.
 *  10. Rotated journal files are replayed in chronological order.
 *  11. Header mid-stream dimension change stops replay at that boundary.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionId } from '@quanta/host-common';

import { VtEmulator } from '../../../shared/lib/vt-emulator/index.js';
import {
  JOURNAL_VERSION,
  HEADER_LEN,
  JournalFormatError,
  readHeader,
} from '../journal-format.js';
import { type JournalPort } from '../journal-port.js';
import { replaySession } from '../replay.js';

/* -------------------- test helpers -------------------- */

/**
 * Build a `.qrpl` byte buffer from scratch. Mirrors what the Rust writer
 * emits, byte-for-byte. Any drift here would also drift the Rust side's
 * header fixture test — we keep them structurally similar on purpose.
 */
function buildJournal(params: {
  readonly cols?: number;
  readonly rows?: number;
  readonly createdAtMs?: bigint;
  readonly shell?: string;
  readonly cwd?: string;
  readonly version?: number;
  readonly frames: ReadonlyArray<{ readonly tsMs: number; readonly bytes: Uint8Array }>;
  /** If true, drop the final N bytes to simulate a mid-frame SIGKILL. */
  readonly truncateTailBy?: number;
  /** If true, corrupt the FR magic on the Nth frame (0-indexed). */
  readonly corruptFrameMagicAt?: number;
}): Uint8Array {
  const header = new Uint8Array(HEADER_LEN);
  // Magic
  header.set([0x51, 0x52, 0x50, 0x4c, 0x00, 0x00, 0x00, 0x00], 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(8, params.version ?? JOURNAL_VERSION, true);
  dv.setUint32(12, params.cols ?? 80, true);
  dv.setUint32(16, params.rows ?? 24, true);
  const created = params.createdAtMs ?? 0n;
  dv.setUint32(20, Number(created & 0xffff_ffffn), true);
  dv.setUint32(24, Number((created >> 32n) & 0xffff_ffffn), true);
  const enc = new TextEncoder();
  const shellBytes = enc.encode(params.shell ?? '');
  header.set(shellBytes.subarray(0, Math.min(32, shellBytes.byteLength)), 28);
  const cwdBytes = enc.encode(params.cwd ?? '');
  header.set(cwdBytes.subarray(0, Math.min(256, cwdBytes.byteLength)), 60);

  const frameChunks: Uint8Array[] = [];
  params.frames.forEach((f, i) => {
    const frame = new Uint8Array(10 + f.bytes.byteLength);
    const magic =
      params.corruptFrameMagicAt === i ? [0x46, 0x5a] : [0x46, 0x52];
    frame[0] = magic[0]!;
    frame[1] = magic[1]!;
    const fdv = new DataView(frame.buffer);
    fdv.setUint32(2, f.tsMs, true);
    fdv.setUint32(6, f.bytes.byteLength, true);
    frame.set(f.bytes, 10);
    frameChunks.push(frame);
  });
  const totalLen =
    header.byteLength + frameChunks.reduce((s, c) => s + c.byteLength, 0);
  let full = new Uint8Array(totalLen);
  full.set(header, 0);
  let off = header.byteLength;
  for (const c of frameChunks) {
    full.set(c, off);
    off += c.byteLength;
  }
  if (params.truncateTailBy !== undefined && params.truncateTailBy > 0) {
    full = full.subarray(0, full.byteLength - params.truncateTailBy);
  }
  return full;
}

function fakePort(files: Uint8Array[]): JournalPort {
  return {
    loadSessionJournal: vi.fn(async () => files),
  };
}

const SID = 'sess-test' as SessionId;

/* -------------------- tests -------------------- */

describe('readHeader (journal-format)', () => {
  it('parses a valid header round-trip', () => {
    const j = buildJournal({
      cols: 132,
      rows: 40,
      shell: '/bin/zsh',
      cwd: '/Users/alice/src',
      createdAtMs: 1_700_000_000_000n,
      frames: [],
    });
    const header = readHeader(j);
    expect(header.version).toBe(JOURNAL_VERSION);
    expect(header.cols).toBe(132);
    expect(header.rows).toBe(40);
    expect(header.shell).toBe('/bin/zsh');
    expect(header.cwd).toBe('/Users/alice/src');
    expect(header.createdAtMs).toBe(1_700_000_000_000);
  });

  it('rejects a short buffer', () => {
    expect(() => readHeader(new Uint8Array(100))).toThrow(JournalFormatError);
  });

  it('rejects a bad magic', () => {
    const j = buildJournal({ frames: [] });
    j[0] = 0xff;
    const err = (() => {
      try {
        readHeader(j);
        return null;
      } catch (e) {
        return e as JournalFormatError;
      }
    })();
    expect(err).toBeInstanceOf(JournalFormatError);
    expect(err?.code).toBe('bad_magic');
  });

  it('rejects an unsupported version', () => {
    const j = buildJournal({ version: JOURNAL_VERSION + 1, frames: [] });
    const err = (() => {
      try {
        readHeader(j);
        return null;
      } catch (e) {
        return e as JournalFormatError;
      }
    })();
    expect(err?.code).toBe('unsupported_version');
  });
});

describe('replaySession', () => {
  it('roundtrips PTY bytes into a fresh VtEmulator', async () => {
    const hello = new TextEncoder().encode('hello ');
    const world = new TextEncoder().encode('world!');
    const j = buildJournal({
      cols: 80,
      rows: 24,
      frames: [
        { tsMs: 0, bytes: hello },
        { tsMs: 12, bytes: world },
      ],
    });

    const feeds: Uint8Array[] = [];
    // Spy emulator — records every feed call so we can verify byte-exact
    // replay without inspecting the grid.
    const spy = {
      feed: (bytes: Uint8Array) => feeds.push(bytes),
    } as unknown as VtEmulator;

    const result = await replaySession(SID, {
      port: fakePort([j]),
      makeEmulator: () => spy,
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.emulator).toBe(spy);
    expect(result.playedFrames).toBe(2);
    expect(result.playedBytes).toBe(hello.byteLength + world.byteLength);
    expect(feeds.length).toBe(2);
    expect(Array.from(feeds[0]!)).toEqual(Array.from(hello));
    expect(Array.from(feeds[1]!)).toEqual(Array.from(world));
  });

  it('missing journal resolves to `no_journal` fallback', async () => {
    const result = await replaySession(SID, { port: fakePort([]) });
    expect(result.fallbackReason).toBe('no_journal');
    expect(result.emulator).toBeNull();
    expect(result.playedFrames).toBe(0);
  });

  it('bad magic surfaces `header_rejected`', async () => {
    const j = buildJournal({ frames: [{ tsMs: 0, bytes: new Uint8Array([1]) }] });
    j[0] = 0xff;
    const result = await replaySession(SID, { port: fakePort([j]) });
    expect(result.fallbackReason).toBe('header_rejected');
    expect(result.emulator).toBeNull();
  });

  it('unsupported version surfaces `header_rejected`', async () => {
    const j = buildJournal({
      version: JOURNAL_VERSION + 1,
      frames: [{ tsMs: 0, bytes: new Uint8Array([1]) }],
    });
    const result = await replaySession(SID, { port: fakePort([j]) });
    expect(result.fallbackReason).toBe('header_rejected');
    expect(result.emulator).toBeNull();
  });

  it('short tail (mid-frame truncation) stops cleanly without throwing', async () => {
    const j = buildJournal({
      frames: [
        { tsMs: 0, bytes: new TextEncoder().encode('first  ') },
        { tsMs: 10, bytes: new TextEncoder().encode('second frame payload') },
      ],
      truncateTailBy: 5,
    });
    const feeds: Uint8Array[] = [];
    const spy = { feed: (b: Uint8Array) => feeds.push(b) } as unknown as VtEmulator;
    const result = await replaySession(SID, {
      port: fakePort([j]),
      makeEmulator: () => spy,
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.playedFrames).toBe(1);
    expect(Array.from(feeds[0]!)).toEqual(
      Array.from(new TextEncoder().encode('first  ')),
    );
  });

  it('corrupt middle frame truncates replay', async () => {
    const j = buildJournal({
      frames: [
        { tsMs: 0, bytes: new TextEncoder().encode('A') },
        { tsMs: 1, bytes: new TextEncoder().encode('B') },
        { tsMs: 2, bytes: new TextEncoder().encode('C') },
      ],
      corruptFrameMagicAt: 1,
    });
    const feeds: Uint8Array[] = [];
    const spy = { feed: (b: Uint8Array) => feeds.push(b) } as unknown as VtEmulator;
    const result = await replaySession(SID, {
      port: fakePort([j]),
      makeEmulator: () => spy,
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.playedFrames).toBe(1);
    expect(Array.from(feeds[0]!)).toEqual(
      Array.from(new TextEncoder().encode('A')),
    );
  });

  it('storm: size-budget-exceeded skips replay entirely', async () => {
    const big = new Uint8Array(5 * 1024);
    for (let i = 0; i < big.byteLength; i += 1) big[i] = 0x41 + (i % 26);
    const j = buildJournal({
      frames: [
        { tsMs: 0, bytes: big },
        { tsMs: 1, bytes: big },
      ],
    });
    const feeds: Uint8Array[] = [];
    const spy = { feed: (b: Uint8Array) => feeds.push(b) } as unknown as VtEmulator;
    const result = await replaySession(SID, {
      port: fakePort([j]),
      makeEmulator: () => spy,
      storm: { sizeBudgetBytes: 1024, timeBudgetMs: 500 },
    });
    expect(result.fallbackReason).toBe('size_budget_exceeded');
    expect(result.emulator).toBeNull();
    expect(feeds.length).toBe(0);
  });

  it('storm: time-budget-exceeded returns partial replay', async () => {
    const payloads = Array.from({ length: 50 }, (_v, i) =>
      new TextEncoder().encode(`tick-${i}`),
    );
    const j = buildJournal({
      frames: payloads.map((p, i) => ({ tsMs: i, bytes: p })),
    });
    const feeds: Uint8Array[] = [];
    const spy = { feed: (b: Uint8Array) => feeds.push(b) } as unknown as VtEmulator;
    // Fake clock jumps 100 ms per call; time-budget 150 ms means we allow
    // ~1 frame through before the cutoff fires on the next loop iteration.
    let t = 0;
    const now = () => {
      const v = t;
      t += 100;
      return v;
    };
    const result = await replaySession(SID, {
      port: fakePort([j]),
      makeEmulator: () => spy,
      now,
      storm: { timeBudgetMs: 150, sizeBudgetBytes: 10 * 1024 * 1024 },
    });
    expect(result.fallbackReason).toBe('time_budget_exceeded');
    expect(result.playedFrames).toBeGreaterThan(0);
    expect(result.playedFrames).toBeLessThan(payloads.length);
    expect(result.emulator).toBe(spy);
  });

  it('replays rotated journals in chronological order', async () => {
    const older = buildJournal({
      frames: [
        { tsMs: 0, bytes: new TextEncoder().encode('old-') },
      ],
    });
    const active = buildJournal({
      frames: [
        { tsMs: 0, bytes: new TextEncoder().encode('new-') },
      ],
    });
    const feeds: string[] = [];
    const spy = {
      feed: (b: Uint8Array) => feeds.push(new TextDecoder().decode(b)),
    } as unknown as VtEmulator;
    const result = await replaySession(SID, {
      // Port contract: oldest → newest.
      port: fakePort([older, active]),
      makeEmulator: () => spy,
    });
    expect(result.fallbackReason).toBeNull();
    expect(feeds).toEqual(['old-', 'new-']);
  });

  it('aborts replay at a mid-stream dimension change', async () => {
    const first = buildJournal({
      cols: 80,
      rows: 24,
      frames: [{ tsMs: 0, bytes: new TextEncoder().encode('A') }],
    });
    const resized = buildJournal({
      cols: 132,
      rows: 40,
      frames: [{ tsMs: 0, bytes: new TextEncoder().encode('B') }],
    });
    const feeds: string[] = [];
    const spy = {
      feed: (b: Uint8Array) => feeds.push(new TextDecoder().decode(b)),
    } as unknown as VtEmulator;
    const result = await replaySession(SID, {
      port: fakePort([first, resized]),
      makeEmulator: () => spy,
    });
    expect(result.fallbackReason).toBeNull();
    expect(feeds).toEqual(['A']);
  });

  it('feeds byte-exact data into a real VtEmulator', async () => {
    // Drive a real emulator so we catch regressions where a feed mangled
    // the input before reaching the VT FSM (e.g. treating the array as a
    // string, or re-encoding). The emulator's `feedBytesTotal` counter is
    // the simplest observable invariant.
    const payloads = [
      new TextEncoder().encode('\x1b[2J\x1b[H'),
      new TextEncoder().encode('hello\r\n'),
      new TextEncoder().encode('world\r\n'),
    ];
    const j = buildJournal({
      cols: 80,
      rows: 24,
      frames: payloads.map((b, i) => ({ tsMs: i * 3, bytes: b })),
    });
    const result = await replaySession(SID, {
      port: fakePort([j]),
    });
    expect(result.emulator).not.toBeNull();
    expect(result.emulator!.feedBytesTotal).toBe(
      payloads.reduce((s, p) => s + p.byteLength, 0),
    );
  });
});
