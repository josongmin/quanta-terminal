/**
 * IndexedDB wrapper tests (jsdom-safe).
 *
 * jsdom doesn't ship an `indexedDB` global, so the wrapper is exercised
 * against the in-memory mock from `__mocks__/fake-idb.ts`. The test covers
 * only the adapter layer: open, put/get, index range reads, count, delete
 * range. Schema semantics live with the callers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  countInIndex,
  deleteRange,
  deleteRecord,
  getAllFromIndex,
  getRecord,
  openDatabase,
  putRecord,
  putRecords,
  type IdbSchema,
} from '../idb.js';
import { fakeIdbFactory, fakeKeyRange, resetFakeIdb } from '../__mocks__/fake-idb.js';

interface Row {
  readonly workspaceId: string;
  readonly id: string;
  readonly endedAt: number;
  readonly label: string;
}

const SCHEMA: IdbSchema = {
  name: 'idb-wrapper-test',
  version: 1,
  stores: [
    {
      name: 'rows',
      keyPath: ['workspaceId', 'id'],
      indexes: [
        { name: 'byWorkspace', keyPath: 'workspaceId' },
        { name: 'byEnded', keyPath: ['workspaceId', 'endedAt'] },
      ],
    },
  ],
};

beforeEach(() => {
  resetFakeIdb();
});

describe('idb wrapper — open + round-trip', () => {
  it('creates stores and persists values across transactions', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    const row: Row = { workspaceId: 'w1', id: 'a', endedAt: 10, label: 'hello' };
    await putRecord(handle, 'rows', row);
    const got = await getRecord<Row>(handle, 'rows', ['w1', 'a']);
    expect(got).toEqual(row);
    handle.close();
  });

  it('batch-writes via putRecords', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    const rows: readonly Row[] = [
      { workspaceId: 'w1', id: 'a', endedAt: 1, label: 'x' },
      { workspaceId: 'w1', id: 'b', endedAt: 2, label: 'y' },
      { workspaceId: 'w2', id: 'a', endedAt: 3, label: 'z' },
    ];
    await putRecords(handle, 'rows', rows);
    const all = await getAllFromIndex<Row>(
      handle,
      'rows',
      'byWorkspace',
      fakeKeyRange.only('w1'),
    );
    expect(all.length).toBe(2);
  });

  it('getAllFromIndex respects ranges and returns sorted rows', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    await putRecords(handle, 'rows', [
      { workspaceId: 'w1', id: 'a', endedAt: 10, label: 'a' },
      { workspaceId: 'w1', id: 'b', endedAt: 20, label: 'b' },
      { workspaceId: 'w1', id: 'c', endedAt: 30, label: 'c' },
    ]);
    const range = fakeKeyRange.bound(['w1', 15], ['w1', 25]);
    const rows = await getAllFromIndex<Row>(handle, 'rows', 'byEnded', range);
    expect(rows.map((r) => r.label)).toEqual(['b']);
  });

  it('count returns the number of records in range', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    await putRecords(handle, 'rows', [
      { workspaceId: 'w1', id: 'a', endedAt: 10, label: 'a' },
      { workspaceId: 'w1', id: 'b', endedAt: 20, label: 'b' },
    ]);
    const n = await countInIndex(handle, 'rows', 'byWorkspace', fakeKeyRange.only('w1'));
    expect(n).toBe(2);
  });

  it('deleteRecord removes a single row', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    await putRecord(handle, 'rows', {
      workspaceId: 'w1',
      id: 'a',
      endedAt: 1,
      label: 'only',
    });
    await deleteRecord(handle, 'rows', ['w1', 'a']);
    expect(await getRecord(handle, 'rows', ['w1', 'a'])).toBeUndefined();
  });

  it('deleteRange removes rows matching an index range', async () => {
    const handle = await openDatabase(SCHEMA, fakeIdbFactory);
    await putRecords(handle, 'rows', [
      { workspaceId: 'w1', id: 'a', endedAt: 1, label: 'a' },
      { workspaceId: 'w1', id: 'b', endedAt: 2, label: 'b' },
      { workspaceId: 'w2', id: 'a', endedAt: 3, label: 'c' },
    ]);
    const removed = await deleteRange(
      handle,
      'rows',
      'byWorkspace',
      fakeKeyRange.only('w1'),
    );
    expect(removed).toBe(2);
    expect(
      await countInIndex(handle, 'rows', 'byWorkspace', fakeKeyRange.only('w1')),
    ).toBe(0);
    expect(
      await countInIndex(handle, 'rows', 'byWorkspace', fakeKeyRange.only('w2')),
    ).toBe(1);
  });
});
