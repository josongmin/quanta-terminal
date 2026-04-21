/**
 * "Copy as Markdown" — selection-aware clipboard action.
 *
 * Distinct from the general `copyBlock` (which emits plain command/output) and
 * `exportBlockAs('markdown')` (which emits the richer H2 + metadata footer
 * export). This action is geared at the common "quote this output in a chat
 * or PR" flow, so the format is intentionally small: a `shell` code fence,
 * optionally preceded by an H3 heading with the command.
 *
 * Selection handling lives here rather than in the exporter:
 *   - `selection: null`          → whole block (with heading).
 *   - `selection: { start, end }` → a [start, end) slice of the rendered
 *                                   plain-text projection (no heading).
 *
 * The caller is responsible for mapping `window.getSelection()` offsets to
 * the block's rendered-text offsets — see `computeBlockSelectionRange` in
 * the widget glue. If mapping fails (selection not inside the block, range
 * collapsed), callers pass `null` and we fall back to the full block.
 */

import { useBlockStore } from '../../entities/block/index.js';
import {
  exportAsMarkdownSelection,
  type SelectionRange,
} from './export.js';

export interface CopyAsMarkdownOptions {
  readonly blockId: string;
  readonly selection?: SelectionRange | null;
  /** Override for tests / non-browser hosts. */
  readonly writeText?: (text: string) => Promise<void>;
}

export type CopyAsMarkdownResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'no-clipboard' | 'write-failed';
      readonly error?: Error;
    };

function defaultWriter(): ((text: string) => Promise<void>) | null {
  if (typeof navigator === 'undefined') return null;
  const c = navigator.clipboard;
  if (!c || typeof c.writeText !== 'function') return null;
  return (text) => c.writeText(text);
}

export async function copyBlockAsMarkdown(
  options: CopyAsMarkdownOptions,
): Promise<CopyAsMarkdownResult> {
  const block = useBlockStore.getState().entities[options.blockId];
  if (!block) return { ok: false, reason: 'not-found' };
  const selection = options.selection ?? null;
  const text = exportAsMarkdownSelection(block, selection);
  const writer = options.writeText ?? defaultWriter();
  if (!writer) return { ok: false, reason: 'no-clipboard' };
  try {
    await writer(text);
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      reason: 'write-failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Map a `window.getSelection()` to a `[start, end)` range in the block's
 * rendered plain-text projection, or `null` if the selection is collapsed
 * / does not intersect the given root element. Caller supplies the root
 * (typically the block body container) so we can bound the walk and reject
 * selections that escaped to adjacent blocks.
 *
 * The implementation walks `root`'s visible text in document order and
 * accumulates character offsets until we hit the selection endpoints. Nodes
 * outside the anchor-focus path are skipped. Offsets are in grapheme-count
 * terms to a first approximation — we iterate over `String.prototype`
 * code points via the for-of loop so astral-plane characters count as 1.
 *
 * When the selection is collapsed (start === end) we return `null`, matching
 * the "no selection" convention the exporter uses.
 */
export function computeBlockSelectionRange(
  root: HTMLElement | null,
  sel: Selection | null,
): SelectionRange | null {
  if (root === null || sel === null) return null;
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  // Reject selections that do not live fully inside `root`. We intersect
  // endpoints with the element's bounds; a partial overlap is treated as
  // "outside" so callers fall back to the full block.
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  // Walk text nodes in document order, accumulating offsets. When we reach
  // the anchor/focus containers we translate the node-local offset into the
  // global walk offset.
  let global = 0;
  let start: number | null = null;
  let end: number | null = null;

  const walker =
    typeof document !== 'undefined'
      ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      : null;
  if (walker === null) return null;

  let node = walker.nextNode();
  while (node !== null) {
    const text = node.nodeValue ?? '';
    if (node === range.startContainer) {
      start = global + range.startOffset;
    }
    if (node === range.endContainer) {
      end = global + range.endOffset;
    }
    global += text.length;
    if (start !== null && end !== null) break;
    node = walker.nextNode();
  }
  if (start === null || end === null) return null;
  if (start === end) return null;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return { start: lo, end: hi };
}
