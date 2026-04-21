/**
 * Command palette — "Copy block as Markdown" entry.
 *
 * Verifies:
 *   - the default catalogue includes the command with the expected label,
 *     accelerator (`mod+shift+c`), and section;
 *   - invoking the command's `run()` dispatches the
 *     `quanta:copy-block-as-markdown` window event that BlockCard listens
 *     for.
 */

import { describe, expect, it, vi } from 'vitest';
import { getDefaultCommands } from '../commands.js';

describe('palette — copy block as markdown', () => {
  it('is present with the expected shape', () => {
    const entry = getDefaultCommands().find(
      (c) => c.id === 'actions.copy-block-as-markdown',
    );
    expect(entry).toBeDefined();
    expect(entry?.section).toBe('actions');
    expect(entry?.accelerator).toBe('mod+shift+c');
    expect(entry?.label).toMatch(/copy block as markdown/iu);
    expect(typeof entry?.run).toBe('function');
  });

  it('dispatches quanta:copy-block-as-markdown on run()', () => {
    const listener = vi.fn();
    window.addEventListener('quanta:copy-block-as-markdown', listener);
    try {
      const entry = getDefaultCommands().find(
        (c) => c.id === 'actions.copy-block-as-markdown',
      );
      entry?.run?.();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('quanta:copy-block-as-markdown', listener);
    }
  });
});
