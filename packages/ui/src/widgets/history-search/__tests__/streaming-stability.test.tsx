/**
 * HistorySearch — prepared index stability during streaming.
 *
 * The widget used to subscribe to `useBlockStore((s) => s.entities)`, which
 * flips identity on every streamed byte frame (`appendBlockOutput` replaces
 * the owning block, which replaces the entities map). That resubscription in
 * turn rebuilt the BM25 prepared index on every chunk — potentially tens or
 * hundreds of rebuilds per second during a noisy command.
 *
 * The audit pass replaces the entities subscription with a one-shot
 * `useBlockStore.getState()` read inside the memo, keyed on the id list. This
 * test asserts that:
 *
 *   1. Typing a query yields correct hits;
 *   2. Streaming bytes into an existing block while the panel is open does
 *      NOT invalidate the hit list (result order stable);
 *   3. Adding a NEW block DOES refresh the list (so new commands are findable).
 */

import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistorySearch } from '../HistorySearch.js';
import { useBlockStore } from '../../../entities/block/index.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('<HistorySearch /> streaming stability', () => {
  it('streamed bytes into an existing block do not thrash the result list', async () => {
    // Seed three completed blocks matching "cargo".
    const a = useBlockStore.getState().createBlock('cargo test', '/repo');
    useBlockStore.getState().completeBlock(a, 0);
    const b = useBlockStore.getState().createBlock('cargo build', '/repo');
    useBlockStore.getState().completeBlock(b, 0);
    // A running block whose streaming output must NOT bust the memo.
    const running = useBlockStore.getState().createBlock('echo streaming', '/repo');

    render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo');
    const firstPass = (await screen.findAllByRole('option')).map(
      (el) => el.getAttribute('id') ?? '',
    );
    expect(firstPass.length).toBe(2);

    // Stream 30 bytes into the RUNNING block. Before the fix, each byte
    // caused an entities-map identity flip → `prepareIndex` rebuild. After
    // the fix, the memo depends on the id list only and re-renders the
    // running block's subscribers, not this panel's search path.
    act(() => {
      for (let i = 0; i < 30; i += 1) {
        useBlockStore.getState().appendBlockOutput(running, new Uint8Array([65 + (i % 26)]));
      }
    });

    const afterStream = screen.getAllByRole('option').map(
      (el) => el.getAttribute('id') ?? '',
    );
    // Results stable. (Same ids, same order.)
    expect(afterStream).toEqual(firstPass);
  });

  it('adding a new block refreshes the list on the next render', async () => {
    const a = useBlockStore.getState().createBlock('cargo test', '/repo');
    useBlockStore.getState().completeBlock(a, 0);

    const { rerender } = render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo');
    expect((await screen.findAllByRole('option')).length).toBe(1);

    // A new matching block arrives. Because the memo depends on the id list,
    // and `createBlock` extends `order`, the index rebuilds on the next render.
    act(() => {
      const b = useBlockStore.getState().createBlock('cargo build', '/repo');
      useBlockStore.getState().completeBlock(b, 0);
    });
    rerender(<HistorySearch open onClose={() => undefined} />);
    const hits = await screen.findAllByRole('option');
    expect(hits.length).toBe(2);
  });
});
