/**
 * Command palette — "Toggle pane zoom" entry.
 *
 * Verifies:
 *   - the default catalogue includes the command with the expected label,
 *     accelerator (`mod+shift+enter`), and section;
 *   - invoking the command's `run()` flips `zoomedPaneId` in the pane store
 *     when the tree has more than one leaf;
 *   - `run()` is a no-op on a single-leaf tree so the palette entry never
 *     fires an orphan a11y announcement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultCommands } from '../commands.js';
import { usePaneStore } from '../../../entities/pane/index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;

beforeEach(() => {
  usePaneStore.getState().reset();
});

describe('palette — toggle pane zoom', () => {
  it('is present with the expected shape', () => {
    const entry = getDefaultCommands().find((c) => c.id === 'pane.zoom');
    expect(entry).toBeDefined();
    expect(entry?.section).toBe('actions');
    expect(entry?.accelerator).toBe('mod+shift+enter');
    expect(entry?.label).toMatch(/toggle pane zoom/iu);
    expect(typeof entry?.run).toBe('function');
  });

  it('run() toggles zoomedPaneId on a multi-pane tree', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);

    const entry = getDefaultCommands().find((c) => c.id === 'pane.zoom');
    entry?.run?.();
    // Focus was on B after split; toggle zooms onto B.
    expect(usePaneStore.getState().zoomedPaneId).toBe(B);

    entry?.run?.();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('run() is a no-op on a single-leaf tree', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    const entry = getDefaultCommands().find((c) => c.id === 'pane.zoom');
    entry?.run?.();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('run() is a no-op on an empty tree', () => {
    const entry = getDefaultCommands().find((c) => c.id === 'pane.zoom');
    expect(usePaneStore.getState().root).toBeNull();
    expect(() => entry?.run?.()).not.toThrow();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });
});
