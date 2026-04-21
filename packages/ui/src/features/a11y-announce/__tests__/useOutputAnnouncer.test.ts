/**
 * Tests for the pure line-extraction helper inside `useOutputAnnouncer`.
 *
 * The hook itself composes React + zustand + timers; the interesting policy
 * (ANSI strip, newline split, \r progress-bar squashing, de-dup, truncation)
 * is packaged into `extractAnnouncementLines` specifically so it can be
 * exercised without a DOM or a fake-timers scaffold. The integration path
 * is covered by the LiveRegion test file.
 */

import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_LINE_MAX_CHARS,
  extractAnnouncementLines,
} from '../useOutputAnnouncer.js';

function fresh() {
  return {
    consumedChunks: 0,
    lastAnnouncedLine: '',
    partial: '',
    truncating: false,
  };
}

describe('extractAnnouncementLines', () => {
  it('yields nothing when no newline has arrived yet', () => {
    const out = extractAnnouncementLines(fresh(), 'hello');
    expect(out.lines).toEqual([]);
    expect(out.cursor.partial).toBe('hello');
  });

  it('emits a line once the newline is seen', () => {
    const step1 = extractAnnouncementLines(fresh(), 'hello');
    const step2 = extractAnnouncementLines(step1.cursor, ' world\n');
    expect(step2.lines).toEqual(['hello world']);
    expect(step2.cursor.partial).toBe('');
  });

  it('deduplicates consecutive identical progress-bar lines', () => {
    const a = extractAnnouncementLines(fresh(), 'installing\ninstalling\ninstalling\n');
    expect(a.lines).toEqual(['installing']);
  });

  it('squashes \\r-based line rewrites to the final committed state', () => {
    // A progress bar that overwrites itself within one line:
    //    "20%\r40%\r60%\r80%\r100%\n"
    const out = extractAnnouncementLines(fresh(), '20%\r40%\r60%\r80%\r100%\n');
    expect(out.lines).toEqual(['100%']);
  });

  it('truncates lines longer than the max with an ellipsis', () => {
    const big = 'x'.repeat(ANNOUNCE_LINE_MAX_CHARS + 50);
    const out = extractAnnouncementLines(fresh(), `${big}\n`);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.length).toBe(ANNOUNCE_LINE_MAX_CHARS);
    expect(out.lines[0]!.endsWith('…')).toBe(true);
  });

  it('does NOT re-announce the trailing continuation of a truncated line', () => {
    // Feed a huge partial that overshoots WITHOUT a newline, then a small
    // chunk that completes the line. The truncated prefix should emit once,
    // and the remainder is dropped silently until the newline.
    const big = 'y'.repeat(ANNOUNCE_LINE_MAX_CHARS + 50);
    const step1 = extractAnnouncementLines(fresh(), big);
    expect(step1.lines).toHaveLength(1);
    expect(step1.lines[0]!.endsWith('…')).toBe(true);
    expect(step1.cursor.truncating).toBe(true);

    const step2 = extractAnnouncementLines(step1.cursor, 'zzz\nnew line\n');
    // The "zzz" continuation is dropped; "new line" is a fresh line.
    expect(step2.lines).toEqual(['new line']);
    expect(step2.cursor.truncating).toBe(false);
  });

  it('drops pure whitespace / empty lines', () => {
    const out = extractAnnouncementLines(fresh(), '\n   \nhello\n');
    expect(out.lines).toEqual(['hello']);
  });

  it('preserves the unterminated partial across calls', () => {
    const s1 = extractAnnouncementLines(fresh(), 'part');
    expect(s1.lines).toEqual([]);
    const s2 = extractAnnouncementLines(s1.cursor, 'ial');
    expect(s2.lines).toEqual([]);
    const s3 = extractAnnouncementLines(s2.cursor, '-done\n');
    expect(s3.lines).toEqual(['partial-done']);
  });
});
