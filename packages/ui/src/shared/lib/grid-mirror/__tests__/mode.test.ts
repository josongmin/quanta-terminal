/**
 * `applyMode` / `getMode` / `snapshotMode` semantics.
 */

import { describe, expect, it } from 'vitest';
import { GridMirror } from '../GridMirror.js';
import { blankSnapshot, modeEnv } from './fixtures.js';

describe('GridMirror mode reducer', () => {
  it('applies a ModeChanged batch atomically', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const r = m.applyMode(
      modeEnv(
        [
          { mode: 'alt_screen', value: true },
          { mode: 'mouse_tracking', value: 'button_event' },
          { mode: 'mouse_encoding', value: 'sgr' },
        ],
        {
          alt_screen: true,
          mouse_tracking: 'button_event',
          mouse_encoding: 'sgr',
        },
        { seq: 1 },
      ),
    );
    expect(r.outcome).toBe('applied');
    const mode = m.getMode();
    expect(mode.alt_screen).toBe(true);
    expect(mode.mouse_tracking).toBe('button_event');
    expect(mode.mouse_encoding).toBe('sgr');
  });

  it('snapshotMode returns a deep-frozen clone', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applyMode(
      modeEnv(
        [{ mode: 'bracketed_paste', value: true }],
        { bracketed_paste: true },
        { seq: 1 },
      ),
    );
    const snap = m.snapshotMode();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      // @ts-expect-error — intentionally trying to mutate a frozen object.
      snap.bracketed_paste = false;
    }).toThrow();
  });

  it('post-snapshot mode_state replaces prior in-flight mode deltas', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applyMode(
      modeEnv(
        [{ mode: 'alt_screen', value: true }],
        { alt_screen: true },
        { seq: 1 },
      ),
    );
    m.applySnapshot({
      ...blankSnapshot(2, 4, 2, 1),
      payload: {
        ...blankSnapshot(2, 4, 2, 1).payload,
        mode_state: { alt_screen: false, bracketed_paste: true },
      },
    });
    expect(m.getMode().alt_screen).toBe(false);
    expect(m.getMode().bracketed_paste).toBe(true);
  });
});
