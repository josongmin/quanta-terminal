/**
 * Rerun a block — resubmits its original command.
 *
 * Submit ownership
 * ----------------
 * `features/composer/submit` is the canonical submit path but belongs to
 * Agent C's slice. FSD's "no cross-slice imports within a layer" rule (ADR
 * 0014) forbids us from reaching into it from `features/block/`. We take a
 * `submit(text, opts)` callback by injection instead — `pages/terminal-page`
 * wires the real submit in, and tests pass a spy.
 *
 * Rerun lineage (Phase 4)
 * -----------------------
 * The submit callback receives a second `opts` argument that carries the
 * predecessor block id. The Compare panel reads the resulting `rerunOfId` to
 * pair an old run with its replay. Older callers passing a single-argument
 * `submit(text)` keep working: we supply an adapter that drops the opts.
 *
 * Returns the submit result so the caller (BlockList host) can surface toasts
 * or analytics. A missing block id resolves to `{ ok: false, reason: 'not-found' }`.
 */

import { useBlockStore } from '../../entities/block/index.js';

export interface RerunSubmitOptions {
  /** Predecessor id — stamped onto the new block's `rerunOfId`. */
  readonly rerunOf: string;
}

export interface RerunOptions {
  readonly blockId: string;
  /**
   * Submit callback. The new (extended) signature receives an `opts` bag
   * carrying the lineage pointer. We accept the legacy single-arg shape too
   * so existing call sites don't have to change in lockstep — the adapter
   * below normalizes.
   */
  readonly submit:
    | ((text: string, opts: RerunSubmitOptions) => Promise<void>)
    | ((text: string) => Promise<void>);
}

export type RerunResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'submit-failed'; readonly error?: Error };

export async function rerunBlock(options: RerunOptions): Promise<RerunResult> {
  const block = useBlockStore.getState().entities[options.blockId];
  if (!block) return { ok: false, reason: 'not-found' };
  try {
    // `.length` is the declared arity. A single-arg submit (length <= 1)
    // is the legacy shape — call it unadorned. Anything else gets the
    // lineage pointer.
    if (options.submit.length >= 2) {
      const withOpts = options.submit as (
        text: string,
        opts: RerunSubmitOptions,
      ) => Promise<void>;
      await withOpts(block.command, { rerunOf: block.id });
    } else {
      const legacy = options.submit as (text: string) => Promise<void>;
      await legacy(block.command);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'submit-failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
