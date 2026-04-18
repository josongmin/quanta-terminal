/**
 * Copy a block's command or output to the system clipboard.
 *
 * Clipboard write is best-effort. On hosts where `navigator.clipboard` is
 * absent or the page lacks permission, we return `{ ok: false }` and let
 * the UI show a toast. An override is accepted for tests.
 */

import { concatChunks, useBlockStore } from '../../entities/block/index.js';

export type CopyScope = 'command' | 'output';

export interface CopyOptions {
  readonly blockId: string;
  readonly scope: CopyScope;
  /** Override the clipboard write (tests and hosts without `navigator`). */
  readonly writeText?: (text: string) => Promise<void>;
}

export type CopyResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'no-clipboard' | 'write-failed'; readonly error?: Error };

function defaultWriter(): ((text: string) => Promise<void>) | null {
  if (typeof navigator === 'undefined') return null;
  const c = navigator.clipboard;
  if (!c || typeof c.writeText !== 'function') return null;
  return (text) => c.writeText(text);
}

const DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

export async function copyBlock(options: CopyOptions): Promise<CopyResult> {
  const block = useBlockStore.getState().entities[options.blockId];
  if (!block) return { ok: false, reason: 'not-found' };
  const text =
    options.scope === 'command'
      ? block.command
      : DECODER.decode(concatChunks(block.outputChunks));
  const writer = options.writeText ?? defaultWriter();
  if (!writer) return { ok: false, reason: 'no-clipboard' };
  try {
    await writer(text);
    return { ok: true, bytes: text.length };
  } catch (err) {
    return {
      ok: false,
      reason: 'write-failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
