/**
 * alt-screen-driver — Plan 0005 §P1-D exit gate.
 *
 * Covers the DECSET 1049/1047/47 → push(tui) / pop(tui) transform, nested
 * enters, chunk-straddle tolerance, and dispose cleanup.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModeStackStore } from '../../mode-stack-store.js';
import { createAltScreenDriver } from '../../drivers/alt-screen-driver.js';

const enc = new TextEncoder();

describe('alt-screen-driver', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('pushes a tui layer on ESC[?1049h', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b[?1049h'));
    const layers = useModeStackStore.getState().layers;
    expect(layers.map((l) => l.kind)).toEqual(['shell', 'tui']);
    expect(layers[1]?.renderHint).toBe('chrome');
    expect(layers[1]?.mousePolicy).toBe('innermost_wins');
  });

  it('pops the tui layer on ESC[?1049l', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b[?1049h'));
    driver.feed(enc.encode('\x1b[?1049l'));
    expect(useModeStackStore.getState().layers).toHaveLength(1);
  });

  it('nested enters stack (vim inside tmux-pane is two pushes)', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b[?1049h\x1b[?1049h'));
    const layers = useModeStackStore.getState().layers;
    expect(layers.filter((l) => l.kind === 'tui')).toHaveLength(2);
  });

  it('handles CSI straddling a chunk boundary', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b[?10'));
    driver.feed(enc.encode('49h'));
    expect(useModeStackStore.getState().layers).toHaveLength(2);
  });

  it('ignores ?1049-looking bytes inside an OSC payload', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b]0;fake \x1b[?1049h\x07after'));
    // The OSC should fully consume the inner CSI-looking bytes.
    expect(useModeStackStore.getState().layers).toHaveLength(1);
  });

  it('dispose pops every outstanding layer', () => {
    const driver = createAltScreenDriver({
      stack: useModeStackStore.getState(),
    });
    driver.feed(enc.encode('\x1b[?1049h\x1b[?47h'));
    expect(useModeStackStore.getState().layers).toHaveLength(3);
    driver.dispose();
    expect(useModeStackStore.getState().layers).toHaveLength(1);
  });
});
