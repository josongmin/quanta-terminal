/**
 * nested-shell-driver — Plan 0005 §P1-D exit gate.
 *
 * Covers: SHLVL push, SHLVL pop, idempotence at the root.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModeStackStore } from '../../mode-stack-store.js';
import { createNestedShellDriver } from '../../drivers/nested-shell-driver.js';

describe('nested-shell-driver', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('SHLVL 1 → 2 pushes exactly one nested-shell layer', () => {
    const driver = createNestedShellDriver({
      stack: useModeStackStore.getState(),
      rootLevel: 1,
    });
    driver.setShellLevel(1); // no-op (baseline)
    expect(driver.depth()).toBe(0);
    driver.setShellLevel(2);
    expect(driver.depth()).toBe(1);
    expect(
      useModeStackStore
        .getState()
        .layers.filter((l) => l.kind === 'nested-shell'),
    ).toHaveLength(1);
  });

  it('SHLVL 1 → 3 pushes two nested-shell layers', () => {
    const driver = createNestedShellDriver({
      stack: useModeStackStore.getState(),
      rootLevel: 1,
    });
    driver.setShellLevel(3);
    expect(driver.depth()).toBe(2);
  });

  it('SHLVL 3 → 1 pops every nested layer; SHLVL below root is clamped to 0', () => {
    const driver = createNestedShellDriver({
      stack: useModeStackStore.getState(),
      rootLevel: 1,
    });
    driver.setShellLevel(3);
    expect(driver.depth()).toBe(2);
    driver.setShellLevel(1);
    expect(driver.depth()).toBe(0);
    driver.setShellLevel(0); // below root — still 0 layers
    expect(driver.depth()).toBe(0);
  });
});
