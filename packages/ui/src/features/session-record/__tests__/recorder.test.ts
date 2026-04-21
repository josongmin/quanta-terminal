/**
 * recorder.ts — unit tests.
 *
 * Covers:
 *   - elapsed-time math (subtracts startedAt, seconds with 6 decimals);
 *   - Uint8Array and string input paths;
 *   - 32 MiB overflow cap fires onOverflow and stops the recorder;
 *   - serialize produces valid JSONL (header + events, each parseable);
 *   - multiple start()s reset state.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createRecorder,
  DEFAULT_MAX_BYTES,
  suggestCastFilename,
  type AsciicastHeader,
} from '../recorder.js';

const HEADER: AsciicastHeader = {
  version: 2,
  width: 80,
  height: 24,
  timestamp: 1_719_000_000,
  env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
};

describe('createRecorder', () => {
  it('computes elapsed seconds relative to start time', () => {
    let clock = 0;
    const rec = createRecorder({ header: HEADER, now: () => clock });
    clock = 1_000;
    rec.start();
    rec.pushChunk('a', clock + 250);
    rec.pushChunk('b', clock + 1_500);
    rec.stop();
    const lines = rec.serialize().trimEnd().split('\n');
    expect(lines.length).toBe(3); // header + 2 events
    const ev1 = JSON.parse(lines[1]!);
    const ev2 = JSON.parse(lines[2]!);
    expect(ev1).toEqual([0.25, 'o', 'a']);
    expect(ev2).toEqual([1.5, 'o', 'b']);
  });

  it('decodes Uint8Array chunks as UTF-8', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    rec.start();
    // "héllo" → UTF-8: 68 c3 a9 6c 6c 6f
    const bytes = new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
    rec.pushChunk(bytes, 0);
    rec.stop();
    const lines = rec.serialize().trim().split('\n');
    const ev = JSON.parse(lines[1]!);
    expect(ev[2]).toBe('héllo');
  });

  it('preserves escape sequences verbatim in serialized JSON', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    rec.start();
    const payload = '\x1b[31mhi\x1b[0m\n';
    rec.pushChunk(payload, 500);
    rec.stop();
    const lines = rec.serialize().trim().split('\n');
    const ev = JSON.parse(lines[1]!);
    expect(ev[2]).toBe(payload);
  });

  it('trips the buffer cap and surfaces onOverflow', () => {
    const onOverflow = vi.fn();
    const rec = createRecorder({
      header: HEADER,
      now: () => 0,
      maxBytes: 16,
      onOverflow,
    });
    rec.start();
    expect(rec.pushChunk('0123456789abcdef', 0)).toBe(true); // exactly 16 bytes
    expect(rec.pushChunk('extra', 0)).toBe(false);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(rec.isRecording()).toBe(false);
    expect(rec.byteCount()).toBe(16);
  });

  it('ignores push calls when not recording', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    expect(rec.pushChunk('x', 0)).toBe(false);
    expect(rec.byteCount()).toBe(0);
  });

  it('serialize produces a parseable asciicast v2 document', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    rec.start();
    rec.pushChunk('hello\r\n', 123);
    rec.pushChunk('world\r\n', 999);
    rec.stop();
    const out = rec.serialize();
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.trim().split('\n');
    const header = JSON.parse(lines[0]!);
    expect(header.version).toBe(2);
    expect(header.width).toBe(80);
    expect(header.height).toBe(24);
    expect(header.env.TERM).toBe('xterm-256color');
    for (let i = 1; i < lines.length; i += 1) {
      const ev = JSON.parse(lines[i]!);
      expect(Array.isArray(ev)).toBe(true);
      expect(ev.length).toBe(3);
      expect(typeof ev[0]).toBe('number');
      expect(ev[1]).toBe('o');
      expect(typeof ev[2]).toBe('string');
    }
  });

  it('restart resets events and byte counter', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    rec.start();
    rec.pushChunk('first', 0);
    rec.stop();
    expect(rec.byteCount()).toBe(5);
    rec.start();
    expect(rec.byteCount()).toBe(0);
    expect(rec.eventCount()).toBe(0);
    rec.pushChunk('next', 0);
    rec.stop();
    const lines = rec.serialize().trim().split('\n');
    // header + 1 event (the 'first' event was cleared on restart)
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]!)).toEqual([0, 'o', 'next']);
  });

  it('serialize with no events returns just the header line', () => {
    const rec = createRecorder({ header: HEADER, now: () => 0 });
    rec.start();
    rec.stop();
    const out = rec.serialize();
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.trim())).toMatchObject({ version: 2 });
  });

  it('rejects malformed headers', () => {
    expect(() =>
      createRecorder({
        header: { ...HEADER, width: 0 },
      }),
    ).toThrow(/width/);
    expect(() =>
      createRecorder({
        header: { ...HEADER, version: 1 as unknown as 2 },
      }),
    ).toThrow(/version/);
  });

  it('DEFAULT_MAX_BYTES matches the 32 MiB brief', () => {
    expect(DEFAULT_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('suggestCastFilename', () => {
  it('renders a filesystem-safe compact timestamp', () => {
    const ms = Date.UTC(2026, 3, 20, 12, 34, 56); // 2026-04-20T12:34:56Z
    // Cannot assert exact string (timezone-dependent), only the shape.
    const name = suggestCastFilename(ms);
    expect(name).toMatch(/^quanta-\d{8}T\d{6}\.cast$/);
  });
});
