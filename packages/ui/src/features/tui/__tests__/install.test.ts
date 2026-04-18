/**
 * Install tests — verify that the TUI detector subscribes to the command
 * router's raw-chunk side-channel and drives the tui store appropriately.
 *
 * We install the command router so `appendToActiveBlock` actually forwards
 * into our observer; without installation the router drops every chunk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTuiDetector } from '../install.js';
import { useTuiStore } from '../../../entities/tui/index.js';
import type { SessionId } from '@quanta/host-common';
// Cross-slice (tests): we drive the command router directly to verify the
// TUI detector registers through its raw-chunk side-channel. Mirrors the
// production cross-slice escape hatch in `features/tui/install.ts`.
// FIXME(fsd-layer-skip): tui install test drives the command router directly
import { __resetRouterForTests, __resetRawObserversForTests, appendToActiveBlock, installCommandRouter } from '../../command/route-output.js';
// FIXME(fsd-layer-skip): tui install test binds the command block-store port fixture
import { bindBlockStore, type BlockStoreActions } from '../../command/block-store-port.js';
// FIXME(fsd-layer-skip): tui install test seeds command.active-block for detector
import { setActiveBlockId } from '../../command/active-block.js';
import type { BlockId } from '../../../shared/types/generated/index.js';

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function makeNoopStore(): BlockStoreActions {
  // The TUI test flow relies on setActiveBlockId actually persisting — the
  // router consults getActiveBlockId on every chunk and drops bytes when
  // it's null.
  let active: BlockId | null = null;
  return {
    createBlock: vi.fn(() => 'blk-new' as BlockId),
    startBlock: vi.fn(() => 'blk-new' as BlockId),
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    appendBlockOutput: vi.fn(),
    completeBlock: vi.fn(),
    cancelBlock: vi.fn(),
    errorBlock: vi.fn(),
    getRunningBlockIds: vi.fn(() => []),
  };
}

let routerDispose: (() => void) | undefined;
let unbindStore: (() => void) | undefined;
let handle: { unsubscribe(): void } | undefined;

beforeEach(() => {
  __resetRouterForTests();
  __resetRawObserversForTests();
  useTuiStore.getState().reset();

  unbindStore = bindBlockStore(makeNoopStore());
  routerDispose = installCommandRouter('mock' as SessionId).dispose;
  setActiveBlockId('blk-a' as BlockId);
});

afterEach(() => {
  if (handle) handle.unsubscribe();
  if (routerDispose) routerDispose();
  if (unbindStore) unbindStore();
  handle = undefined;
  routerDispose = undefined;
  unbindStore = undefined;
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
});

describe('installTuiDetector', () => {
  it('flips tuiStore.active when a chunk carries alt-screen enter', () => {
    handle = installTuiDetector();
    expect(useTuiStore.getState().active).toBe(false);
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    expect(useTuiStore.getState().active).toBe(true);
    expect(useTuiStore.getState().enteredAt).toBeTypeOf('number');
  });

  it('flips tuiStore.active back when alt-screen exit arrives', () => {
    handle = installTuiDetector();
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049l'));
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.enteredAt).toBeNull();
  });

  it('stays active through nested enter/exit pairs', () => {
    handle = installTuiDetector();
    // Outer vim → inner :shell that re-enters alt-screen → exits both.
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    expect(useTuiStore.getState().active).toBe(true);
    // First exit must NOT drop us out — we are still inside vim.
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049l'));
    expect(useTuiStore.getState().active).toBe(true);
    // Matched outer exit.
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049l'));
    expect(useTuiStore.getState().active).toBe(false);
  });

  it('tolerates an escape sequence split across chunks', () => {
    handle = installTuiDetector();
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?10'));
    expect(useTuiStore.getState().active).toBe(false);
    appendToActiveBlock('mock' as SessionId, textToB64('49h'));
    expect(useTuiStore.getState().active).toBe(true);
  });

  it('unsubscribe detaches from the router and clears active', () => {
    handle = installTuiDetector();
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    expect(useTuiStore.getState().active).toBe(true);
    handle.unsubscribe();
    handle = undefined;
    expect(useTuiStore.getState().active).toBe(false);
    // After unsubscribe, new chunks do not toggle the store.
    appendToActiveBlock('mock' as SessionId, textToB64('\x1b[?1049h'));
    expect(useTuiStore.getState().active).toBe(false);
  });
});
