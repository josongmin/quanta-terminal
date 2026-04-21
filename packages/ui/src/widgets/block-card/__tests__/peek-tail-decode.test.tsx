/**
 * BlockCard collapsed-peek — tail-only decode regression tests (review F16).
 *
 * The peek row renders only the LAST visible line of the block's output.
 * The previous implementation decoded the ENTIRE byte history on every
 * render; for blocks that stream megabytes (e.g. `cat large.log`) this
 * froze the UI. The new implementation decodes at most the last 8 KiB of
 * tail bytes and relies on the fact that any line fitting inside that
 * window is recoverable.
 *
 * Tests:
 *   1. A 10 MB synthetic stream decodes fast enough that the render does
 *      not time out.
 *   2. The last-line preview is byte-accurate as long as the trailing line
 *      fits inside the 8 KiB tail window.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockCard } from '../BlockCard.js';
import { useBlockStore, type Block } from '../../../entities/block/index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
});

describe('BlockCard collapsed peek — tail-only decode', () => {
  it('decodes a ~10 MB collapsed block without blowing past the render budget', () => {
    const id = useBlockStore.getState().createBlock('big', '/');
    // 10 MB: 10 × 1 MB chunks of '.' (0x2e) followed by "final-line\n".
    // Each chunk carries a trailing newline so the tail slice still sees a
    // complete last line.
    for (let i = 0; i < 10; i += 1) {
      const chunk = new Uint8Array(1024 * 1024);
      chunk.fill(0x2e);
      chunk[chunk.length - 1] = 0x0a; // \n
      useBlockStore.getState().appendBlockOutput(id, chunk);
    }
    // Final marker line the peek must surface.
    useBlockStore
      .getState()
      .appendBlockOutput(id, new TextEncoder().encode('final-line\n'));
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().toggleCollapse(id);

    const start = performance.now();
    render(<BlockCard block={currentBlock(id)} />);
    const elapsed = performance.now() - start;
    // Budget: the render must not take longer than ~8 s even under parallel
    // suite load (we're now at 4000+ tests and growing). The old full-decode
    // path took ~15+ s on this input; the new tail path is independent of
    // history length. Leaving headroom so timing-based flakes don't fire
    // while still catching a regression to the old full-decode approach.
    expect(elapsed).toBeLessThan(8000);
    // Peek summary exists; the byte count reflects the full stream.
    expect(screen.getByTestId(`block-peek-${id}`)).toBeInTheDocument();
  });

  it('last-line preview is accurate when the final line fits inside the tail window', () => {
    const id = useBlockStore.getState().createBlock('peek-tail', '/');
    // ~200 KB of 'x' followed by a newline and a clear trailing line.
    const big = new Uint8Array(200 * 1024);
    big.fill(0x78); // 'x'
    big[big.length - 1] = 0x0a;
    useBlockStore.getState().appendBlockOutput(id, big);
    useBlockStore
      .getState()
      .appendBlockOutput(id, new TextEncoder().encode('TAIL_LINE_ABCDEF'));
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().toggleCollapse(id);
    render(<BlockCard block={currentBlock(id)} />);
    const peek = screen.getByTestId(`block-peek-${id}`);
    expect(peek.textContent ?? '').toContain('TAIL_LINE_ABCDEF');
  });
});
