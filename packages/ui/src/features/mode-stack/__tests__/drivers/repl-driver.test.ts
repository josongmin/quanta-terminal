/**
 * repl-driver — Plan 0005 §P1-D exit gate.
 *
 * Covers: python >>>, node >, psql <db>=#, and shell-prompt-pop.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModeStackStore } from '../../mode-stack-store.js';
import { createReplDriver } from '../../drivers/repl-driver.js';

const enc = new TextEncoder();

describe('repl-driver', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('pushes a python repl layer on `>>> `', () => {
    const driver = createReplDriver({ stack: useModeStackStore.getState() });
    driver.feed(enc.encode('Python 3.11.0\n>>> '));
    const layer = useModeStackStore
      .getState()
      .layers.find((l) => l.kind === 'repl');
    expect(layer?.hints?.replShell).toBe('python');
    expect(layer?.inputPolicy).toBe('line_edit');
  });

  it('pushes a node repl layer on `> ` after banner', () => {
    const driver = createReplDriver({ stack: useModeStackStore.getState() });
    driver.feed(enc.encode('Welcome to Node.js v20\nType ".help"\n> '));
    expect(
      useModeStackStore
        .getState()
        .layers.find((l) => l.kind === 'repl')
        ?.hints?.replShell,
    ).toBe('node');
  });

  it('recognizes psql `<db>=#` prompt', () => {
    const driver = createReplDriver({ stack: useModeStackStore.getState() });
    driver.feed(enc.encode('psql (16.1)\nType "help" for help.\n\nmydb=# '));
    const layer = useModeStackStore
      .getState()
      .layers.find((l) => l.kind === 'repl');
    expect(layer?.hints?.replShell).toBe('psql');
  });

  it('pops the repl layer when a shell prompt returns', () => {
    const driver = createReplDriver({ stack: useModeStackStore.getState() });
    driver.feed(enc.encode('Python 3.11\n>>> '));
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'repl'),
    ).toBe(true);
    // User types `exit()` + returns to zsh.
    driver.feed(enc.encode('\nalice@host ~ % '));
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'repl'),
    ).toBe(false);
  });
});
