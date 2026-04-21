/**
 * Copy a block's command or output to the system clipboard.
 *
 * Clipboard write is best-effort. On hosts where `navigator.clipboard` is
 * absent or the page lacks permission, we return `{ ok: false }` and let
 * the UI show a toast. An override is accepted for tests.
 */

import { useBlockStore } from '../../entities/block/index.js';
import { projectChunksToText } from '../../shared/lib/text/index.js';

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

export async function copyBlock(options: CopyOptions): Promise<CopyResult> {
  const block = useBlockStore.getState().entities[options.blockId];
  if (!block) return { ok: false, reason: 'not-found' };
  // Output: decode bytes and strip ANSI escapes before writing to the
  // clipboard. Users paste into editors / chats / tickets — raw ESC bytes
  // (e.g. zsh's PROMPT_EOL_MARK `\e[1m\e[7m%\e[0m`) would render as tofu
  // glyphs in almost every surface. Parity with `exportAsText`.
  const text =
    options.scope === 'command'
      ? block.command
      : projectChunksToText(block.outputChunks);
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
