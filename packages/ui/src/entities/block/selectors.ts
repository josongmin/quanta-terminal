/**
 * Block store selectors — curated hooks for widgets.
 *
 * Block-list renders dozens of cards, each subscribed to its own block. Using
 * targeted selectors here (rather than reading the whole store from every
 * card) keeps re-renders O(affected blocks), not O(total blocks).
 *
 * Two specialized per-block selectors (`useBlockHeader`, `useBlockOutputChunks`)
 * split the block shape along the natural write pattern: `appendBlockOutput`
 * mutates only `outputChunks`, so the header (command / status / duration
 * badges / collapsed+pinned flags) must not re-render on every streamed chunk.
 * The body is the only part that subscribes to the chunk list.
 *
 * Usage:
 *   const ids = useBlockIds();                         // ordered id list
 *   const block = useBlock(id);                        // one block, shallow
 *   const header = useBlockHeader(id);                 // chrome-only view
 *   const stream = useBlockOutputChunks(id);           // body-only view
 *   const activeId = useActiveBlockId();               // current running id
 */

import { useShallow } from 'zustand/react/shallow';
import { useBlockStore, type Block, type BlockState, type BlockStatus } from './model.js';
import type { SessionId } from '../../shared/types/generated/index.js';

/** Ordered list of block ids. Shallow-compared so the array reference only
 *  changes when the order actually changes. */
export function useBlockIds(): readonly string[] {
  return useBlockStore(useShallow((s: BlockState) => s.order));
}

/**
 * Ordered list of block ids belonging to a given session (Phase 4).
 *
 * BlockList uses this to scope the visible history to the active tab.
 * Shallow-compared, so a write to a sibling session's block output does not
 * re-run the returned array for THIS session — the output-chunk change
 * happens inside `entities[otherId]` which is not part of our slice.
 *
 * Returns an empty array when no blocks match (including `id === null`,
 * which is a legitimate transient state before the first spawn finishes).
 */
export function useBlocksForSession(id: SessionId | null): readonly string[] {
  return useBlockStore(
    useShallow((s: BlockState) => {
      if (id === null) return [];
      const out: string[] = [];
      for (const blockId of s.order) {
        const b = s.entities[blockId];
        if (b && b.sessionId === id) out.push(blockId);
      }
      return out;
    }),
  );
}

/**
 * Single block by id. Shallow compare on the block's own fields, so unrelated
 * blocks mutating in the store do not re-run consumers of this hook. The
 * subscription still fires on every meaningful field change of THIS block —
 * including new chunks appended to its `outputChunks`, because that replaces
 * the array reference. Components that only care about chrome (header/meta)
 * should use `useBlockHeader` instead to skip the per-chunk re-render.
 */
export function useBlock(id: string): Block | undefined {
  return useBlockStore(useShallow((s) => s.entities[id]));
}

/**
 * Chrome-only view of a block: everything except the streaming `outputChunks`.
 * Shallow-compared, so a stream-append that only bumps `outputChunks` does NOT
 * re-render the header. Returns `undefined` for an unknown / cleared id.
 */
export interface BlockHeaderView {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly status: BlockStatus;
  readonly cwd: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  readonly collapsed: boolean;
  readonly pinned: boolean;
  readonly errorMessage: string | null;
  /** Rerun lineage pointer; the Compare button is gated on this being set. */
  readonly rerunOfId: string | null;
}

export function useBlockHeader(id: string): BlockHeaderView | undefined {
  return useBlockStore(
    useShallow((s) => {
      const b = s.entities[id];
      if (!b) return undefined;
      return {
        id: b.id,
        sessionId: b.sessionId,
        command: b.command,
        status: b.status,
        cwd: b.cwd,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
        exitCode: b.exitCode,
        collapsed: b.collapsed,
        pinned: b.pinned,
        errorMessage: b.errorMessage,
        rerunOfId: b.rerunOfId,
      };
    }),
  );
}

/**
 * Streaming view of a block: the raw output chunks plus the lifecycle status
 * (the body needs `status` to know when to drain the parser). Shallow-compared
 * on the top-level object so a header-only toggle (collapse, pin) does not
 * re-render the body.
 *
 * NOTE: `outputChunks` itself is replaced on every append — that's the intended
 * re-render trigger for the body subtree. The `chunkCount` field is exposed as
 * a cheap version stamp for AnsiOutput memoization.
 */
export interface BlockStreamView {
  readonly status: BlockStatus;
  readonly outputChunks: readonly Uint8Array[];
  readonly chunkCount: number;
}

export function useBlockOutputChunks(id: string): BlockStreamView | undefined {
  return useBlockStore(
    useShallow((s) => {
      const b = s.entities[id];
      if (!b) return undefined;
      return {
        status: b.status,
        outputChunks: b.outputChunks,
        chunkCount: b.outputChunks.length,
      };
    }),
  );
}

/**
 * Id of the newest block that is still running, or null if none.
 *
 * Order is insertion order (newest at the end), so we scan from the tail.
 * Phase 2 rarely has more than one in-flight block at a time but the store
 * does not forbid it — this selector just picks the latest.
 */
export function useActiveBlockId(): string | null {
  return useBlockStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i -= 1) {
      const id = s.order[i];
      if (!id) continue;
      const b = s.entities[id];
      if (b && b.status === 'running') return id;
    }
    return null;
  });
}

/**
 * Walk the rerun lineage backward from `id` through `rerunOfId` pointers and
 * return the chain ordered oldest → newest. The returned array always ends
 * with the block at `id`; earlier entries are its predecessors.
 *
 * Safety rails:
 *   - An unknown id returns `[]` so callers can early-return on an empty
 *     result without a presence check.
 *   - A cycle (should be impossible under normal flow — ids are immutable and
 *     only ever point at already-existing ids) is guarded by a `seen` set;
 *     once we revisit an id we stop. This turns a pathological state into a
 *     truncation rather than a runtime hang.
 *   - Dangling `rerunOfId` pointers (predecessor was cleared by
 *     `clearHistory`) terminate the walk — the surviving segment is still
 *     returned so the Compare panel can say "no prior run to compare".
 *
 * Exported as a plain function (not a hook) because the Compare flow reads
 * lineage imperatively from `openCompareFromBlock`; hooks would force us to
 * add a React context just to dispatch an action.
 */
export function getRerunLineage(id: string): Block[] {
  const state = useBlockStore.getState();
  return getRerunLineageFromState(state, id);
}

/** Stateless helper — same semantics as `getRerunLineage`, taking a snapshot.
 *  Exposed for tests that construct a minimal state fixture without the
 *  Zustand store. */
export function getRerunLineageFromState(state: BlockState, id: string): Block[] {
  const head = state.entities[id];
  if (!head) return [];
  const reversed: Block[] = [head];
  const seen = new Set<string>([head.id]);
  let cursor = head.rerunOfId;
  while (cursor !== null) {
    if (seen.has(cursor)) break;
    const prev = state.entities[cursor];
    if (!prev) break;
    reversed.push(prev);
    seen.add(prev.id);
    cursor = prev.rerunOfId;
  }
  reversed.reverse();
  return reversed;
}
