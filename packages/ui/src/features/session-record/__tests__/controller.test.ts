/**
 * Controller integration tests — start → pushChunk (via byte bus) → stop →
 * serialize. Also covers the palette-visible `isRecording()` and the
 * `subscribeStopResult` hook used by the terminal page modal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionsStore } from '../../../entities/session/index.js';
import { useSessionRecordStore } from '../../../entities/session-record/index.js';
import {
  __resetSessionRecordControllerForTests,
  isRecording,
  startRecording,
  stopRecording,
  subscribeStopResult,
  toggleRecording,
} from '../controller.js';
import {
  __resetByteBusForTests,
  publishSessionChunk,
} from '../byte-bus.js';

beforeEach(() => {
  __resetByteBusForTests();
  __resetSessionRecordControllerForTests();
  useSessionsStore.getState().reset();
});

afterEach(() => {
  __resetSessionRecordControllerForTests();
  __resetByteBusForTests();
});

function seedSession(id = 'session-1'): void {
  useSessionsStore.getState().addSession({
    id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    cwdSource: 'launch',
    shellIntegration: 'missing',
    health: 'ready',
    exitCode: null,
  });
}

describe('session-record controller', () => {
  it('start → publish → stop produces a valid asciicast', () => {
    seedSession('s1');
    const start = startRecording();
    expect(start.ok).toBe(true);
    expect(isRecording()).toBe(true);
    expect(useSessionRecordStore.getState().recording).toBe(true);
    expect(useSessionRecordStore.getState().sessionId).toBe('s1');

    publishSessionChunk('s1', 'hello\r\n');
    publishSessionChunk('s1', new TextEncoder().encode('world\r\n'));
    // Chunks for other sessions MUST NOT be captured.
    publishSessionChunk('other', 'nope');

    const stop = stopRecording();
    expect(stop.ok).toBe(true);
    expect(stop.eventCount).toBe(2);
    expect(stop.byteCount).toBe(7 + 7);
    expect(isRecording()).toBe(false);
    expect(useSessionRecordStore.getState().recording).toBe(false);

    const lines = stop.jsonl.trim().split('\n');
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]!);
    expect(header).toMatchObject({
      version: 2,
      width: 80,
      height: 24,
      env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
    });
    const ev1 = JSON.parse(lines[1]!);
    const ev2 = JSON.parse(lines[2]!);
    expect(ev1[1]).toBe('o');
    expect(ev1[2]).toBe('hello\r\n');
    expect(ev2[2]).toBe('world\r\n');
  });

  it('startRecording rejects when no active session', () => {
    const start = startRecording();
    expect(start.ok).toBe(false);
    expect(start.reason).toBe('no-active-session');
    expect(isRecording()).toBe(false);
  });

  it('startRecording rejects when already recording', () => {
    seedSession('s1');
    expect(startRecording().ok).toBe(true);
    const second = startRecording();
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already-recording');
  });

  it('toggleRecording publishes the stop result to subscribers', () => {
    seedSession('s1');
    const listener = vi.fn();
    const unsubscribe = subscribeStopResult(listener);
    toggleRecording(); // start
    expect(isRecording()).toBe(true);
    publishSessionChunk('s1', 'x');
    toggleRecording(); // stop
    expect(isRecording()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0]![0];
    expect(payload.ok).toBe(true);
    expect(payload.eventCount).toBe(1);
    unsubscribe();
  });

  it('stop without a running recorder returns ok:false', () => {
    const result = stopRecording();
    expect(result.ok).toBe(false);
    expect(result.jsonl).toBe('');
  });
});
