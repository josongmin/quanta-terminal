/**
 * Palette + keybind wiring smoke test — making sure the command palette
 * exposes a start/stop recording entry and that running it flips the
 * controller's `isRecording` bit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSessionsStore } from '../../../entities/session/index.js';
import {
  __resetSessionRecordControllerForTests,
  isRecording,
} from '../controller.js';
import { __resetByteBusForTests } from '../byte-bus.js';
import { getDefaultCommands } from '../../../widgets/command-palette/commands.js';

beforeEach(() => {
  useSessionsStore.getState().reset();
  __resetByteBusForTests();
  __resetSessionRecordControllerForTests();
});

afterEach(() => {
  __resetSessionRecordControllerForTests();
  __resetByteBusForTests();
});

describe('command palette: Session: Start/Stop recording', () => {
  it('exposes the Start recording entry with mod+shift+r accelerator when idle', () => {
    const entry = getDefaultCommands().find((c) => c.id === 'sessions.start-recording');
    expect(entry).toBeTruthy();
    expect(entry!.accelerator).toBe('mod+shift+r');
    expect(entry!.label).toMatch(/start recording/i);
  });

  it('running the entry toggles controller state', () => {
    useSessionsStore.getState().addSession({
      id: 'session-1',
      shell: '/bin/zsh',
      cwd: '/tmp',
      cwdSource: 'launch',
      shellIntegration: 'missing',
      health: 'ready',
      exitCode: null,
    });
    const start = getDefaultCommands().find((c) => c.id === 'sessions.start-recording');
    expect(start).toBeTruthy();
    start!.run?.();
    expect(isRecording()).toBe(true);
    // After flipping on, the palette exposes the Stop entry.
    const stop = getDefaultCommands().find((c) => c.id === 'sessions.stop-recording');
    expect(stop).toBeTruthy();
    stop!.run?.();
    expect(isRecording()).toBe(false);
  });
});
