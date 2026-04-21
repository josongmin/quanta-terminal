/**
 * Block tags — model actions + selectors.
 *
 * Covers the invariants the UI layer depends on:
 *   - `addTag` normalizes (trim + lowercase) before validation, rejects
 *     invalid inputs, dedupes within a block, and reports whether a new
 *     tag was added via its boolean return.
 *   - `removeTag` is idempotent on absent tags.
 *   - `clearTags` wipes the list.
 *   - `listAllTags` returns every distinct tag sorted by (count desc,
 *     tag asc) so the popover typeahead can rank by popularity.
 *   - Persistence round-trip preserves the tag list (exercised indirectly
 *     here via `serializeBlock` → `deserializeBlock`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  deserializeBlock,
  isValidTag,
  listAllTagsFromState,
  normalizeTag,
  serializeBlock,
  useBlockStore,
} from '../index.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('tag normalization + validation', () => {
  it.each([
    ['bug', 'bug'],
    ['  Bug  ', 'bug'],
    ['DEPLOY', 'deploy'],
    ['my-tag', 'my-tag'],
    ['my_tag', 'my_tag'],
    ['42', '42'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeTag(input)).toBe(expected);
  });

  it.each([
    ['bug', true],
    ['42', true],
    ['a-1', true],
    ['a'.repeat(24), true],
    ['', false],
    ['a'.repeat(25), false],
    ['-lead', false], // leading dash forbidden
    ['_lead', false], // leading underscore forbidden
    ['has space', false],
    ['emoji🎉', false],
    ['punct!', false],
  ])('isValidTag(%s) === %s', (input, expected) => {
    expect(isValidTag(input)).toBe(expected);
  });
});

describe('addTag — the happy path, dedupe, and rejection', () => {
  it('adds a normalized tag and reports true', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const added = useBlockStore.getState().addTag(id, '  Bug  ');
    expect(added).toBe(true);
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['bug']);
  });

  it('returns false when the tag is already on the block (dedup)', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    const added = useBlockStore.getState().addTag(id, 'BUG');
    expect(added).toBe(false);
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['bug']);
  });

  it('returns false for invalid input without touching the block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    expect(useBlockStore.getState().addTag(id, '')).toBe(false);
    expect(useBlockStore.getState().addTag(id, '$$$')).toBe(false);
    expect(useBlockStore.getState().addTag(id, 'a'.repeat(30))).toBe(false);
    expect(useBlockStore.getState().entities[id]?.tags).toEqual([]);
  });

  it('is a no-op on an unknown block id', () => {
    const added = useBlockStore.getState().addTag('missing', 'bug');
    expect(added).toBe(false);
  });
});

describe('removeTag / clearTags', () => {
  it('removes a present tag', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().addTag(id, 'deploy');
    useBlockStore.getState().removeTag(id, 'bug');
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['deploy']);
  });

  it('is a no-op when the tag is not on the block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().removeTag(id, 'unrelated');
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['bug']);
  });

  it('clearTags wipes the list', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'a');
    useBlockStore.getState().addTag(id, 'b');
    useBlockStore.getState().clearTags(id);
    expect(useBlockStore.getState().entities[id]?.tags).toEqual([]);
  });
});

describe('listAllTags — frequency ordering', () => {
  it('orders by descending frequency, then alphabetical', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    const c = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().addTag(a, 'deploy');
    useBlockStore.getState().addTag(b, 'deploy');
    useBlockStore.getState().addTag(c, 'deploy');
    useBlockStore.getState().addTag(a, 'bug');
    useBlockStore.getState().addTag(b, 'bug');
    useBlockStore.getState().addTag(a, 'zeta');

    const snapshot = listAllTagsFromState(useBlockStore.getState());
    // Deploy (3) > bug (2) > zeta (1). Zeta alone — alpha doesn't trigger.
    expect(snapshot.map((f) => f.tag)).toEqual(['deploy', 'bug', 'zeta']);
    expect(snapshot.map((f) => f.count)).toEqual([3, 2, 1]);
  });

  it('alphabetical tiebreak on equal frequency', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    useBlockStore.getState().addTag(a, 'zzz');
    useBlockStore.getState().addTag(b, 'aaa');
    const snapshot = listAllTagsFromState(useBlockStore.getState());
    expect(snapshot.map((f) => f.tag)).toEqual(['aaa', 'zzz']);
  });

  it('returns an empty array when no blocks have tags', () => {
    useBlockStore.getState().createBlock('ls', '/');
    const snapshot = listAllTagsFromState(useBlockStore.getState());
    expect(snapshot).toEqual([]);
  });
});

describe('persistence round-trip for tags', () => {
  it('serializes and deserializes the tag list', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().addTag(id, 'deploy');
    useBlockStore.getState().completeBlock(id, 0);
    const b = useBlockStore.getState().entities[id];
    if (!b) throw new Error('missing');

    const stored = await serializeBlock(b, 'ws_tag');
    expect(stored.tags).toEqual(['bug', 'deploy']);

    const hydrated = await deserializeBlock(stored);
    expect(hydrated.tags).toEqual(['bug', 'deploy']);
  });

  it('hydrates a legacy row (no tags field) with an empty list', async () => {
    // Fabricate a row without `tags` — forward-compat contract.
    const row = {
      id: 'x',
      workspaceId: 'ws_legacy',
      command: 'ls',
      cwd: '/',
      status: 'completed' as const,
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputCompressed: new Uint8Array(0),
      compressed: false,
      pinned: false,
      sessionId: null,
      rerunOfId: null,
      errorMessage: null,
    };
    const hydrated = await deserializeBlock(row);
    expect(hydrated.tags).toEqual([]);
  });
});
