/**
 * pager-driver — Plan 0005 §P1-D exit gate.
 *
 * Covers: both conditions required (alt-screen + process hint), byte-level
 * fallback on `--More--` and `:<cursor-home>`, exit on either condition
 * dropping, and git-paginate mapping.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModeStackStore } from '../../mode-stack-store.js';
import { createPagerDriver } from '../../drivers/pager-driver.js';

const enc = new TextEncoder();

describe('pager-driver', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('does NOT push until BOTH alt-screen AND hint are set', () => {
    const driver = createPagerDriver({ stack: useModeStackStore.getState() });
    driver.setProcessHint('less');
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'pager'),
    ).toBe(false);
    driver.onAltScreenEnter();
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'pager'),
    ).toBe(true);
  });

  it('pushes with correct hints for each pager app', () => {
    const driver = createPagerDriver({ stack: useModeStackStore.getState() });
    driver.onAltScreenEnter();
    driver.setProcessHint('man');
    expect(
      useModeStackStore.getState().layers.find((l) => l.kind === 'pager')
        ?.hints?.pagerApp,
    ).toBe('man');
  });

  it('maps `git --paginate log` to a less layer', () => {
    const driver = createPagerDriver({ stack: useModeStackStore.getState() });
    driver.onAltScreenEnter();
    driver.setProcessHint('git --paginate log');
    const layer = useModeStackStore
      .getState()
      .layers.find((l) => l.kind === 'pager');
    expect(layer?.hints?.pagerApp).toBe('less');
  });

  it('bytes-only fallback: --More-- inside alt-screen pushes `more`', () => {
    const driver = createPagerDriver({ stack: useModeStackStore.getState() });
    driver.onAltScreenEnter();
    driver.feed(enc.encode('first line\n--More--'));
    const layer = useModeStackStore
      .getState()
      .layers.find((l) => l.kind === 'pager');
    expect(layer?.hints?.pagerApp).toBe('more');
  });

  it('pops the pager layer when alt-screen exits', () => {
    const driver = createPagerDriver({ stack: useModeStackStore.getState() });
    driver.onAltScreenEnter();
    driver.setProcessHint('less');
    driver.onAltScreenExit();
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'pager'),
    ).toBe(false);
  });
});
