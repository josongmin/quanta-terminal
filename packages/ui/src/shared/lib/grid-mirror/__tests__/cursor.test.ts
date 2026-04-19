/**
 * `applyCursor` behavior — visibility, shape, blink, pending_wrap.
 */

import { describe, expect, it } from 'vitest';
import { GridMirror } from '../GridMirror.js';
import { blankSnapshot, cursorEnv, defaultCursor } from './fixtures.js';

describe('GridMirror apply_cursor', () => {
  it('applies a CursorMoved event and updates getCursor', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 8, 0, 1));
    const r = m.applyCursor(cursorEnv(defaultCursor(2, 3), { seq: 1 }));
    expect(r.outcome).toBe('applied');
    expect(m.getCursor()).toMatchObject({ row: 2, col: 3 });
  });

  it('propagates the visibility flag', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 8, 0, 1));
    m.applyCursor(
      cursorEnv(
        {
          row: 0,
          col: 0,
          visible: false,
          shape: 'block',
          blinking: true,
          pending_wrap: false,
        },
        { seq: 1 },
      ),
    );
    expect(m.getCursor().visible).toBe(false);
  });

  it('propagates shape + blinking flags', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 8, 0, 1));
    m.applyCursor(
      cursorEnv(
        {
          row: 0,
          col: 0,
          visible: true,
          shape: 'bar',
          blinking: false,
          pending_wrap: false,
        },
        { seq: 1 },
      ),
    );
    expect(m.getCursor().shape).toBe('bar');
    expect(m.getCursor().blinking).toBe(false);
  });

  it('propagates the pending_wrap flag', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 8, 0, 1));
    m.applyCursor(
      cursorEnv(
        {
          row: 1,
          col: 7,
          visible: true,
          shape: 'block',
          blinking: true,
          pending_wrap: true,
        },
        { seq: 1 },
      ),
    );
    expect(m.getCursor().pending_wrap).toBe(true);
  });

  it('picks up the buffer_kind tag on each cursor event', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 8, 0, 1));
    m.applyCursor(cursorEnv(defaultCursor(), { seq: 1, buffer_kind: 'alt' }));
    expect(m.getBufferKind()).toBe('alt');
  });
});
