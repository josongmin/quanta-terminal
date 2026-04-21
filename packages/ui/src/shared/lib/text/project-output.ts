/**
 * Project a sequence of PTY byte chunks (or a single concatenated buffer) into
 * stripped plain text.
 *
 * This exists so downstream consumers (a11y announce, AI explain, output
 * search, history indexing, block copy / export, compare diff) never reach
 * into `shared/lib/ansi-parser` directly — the CI grep rule
 * `tools/check-one-render-path` enforces that invariant.
 *
 * Pipeline:
 *   chunks (or one Uint8Array)
 *     → concat (single allocation, so UTF-8 codepoints that straddle chunk
 *       boundaries don't mojibake when decoded)
 *     → TextDecoder('utf-8', { fatal: false })
 *     → stripAnsi (CSI, OSC, DCS, charset-selects, bare two-byte ESC, C0
 *       controls except \t \n \r, zsh PROMPT_EOL_MARK)
 *
 * Safe to call with an empty input — returns `''`. Pure: no side effects, no
 * hidden state. Callers that need row-range projections from the engine's
 * `GridMirror` use a different helper; this one is purely for
 * "give me the plain text the user would copy / index / read aloud."
 */

import { stripAnsi } from '../ansi-parser/strip.js';

export { stripAnsi };

/** Shared decoder — permissive (non-fatal) so a half-written multibyte tail
 * at the end of a stream doesn't throw. Hoisted to module scope so hot loops
 * (search recompute, announce polling) don't pay an allocation per call. */
const DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

function totalLength(chunks: readonly Uint8Array[]): number {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  return n;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) {
    // Safe to return the first chunk directly — we only pass it to
    // TextDecoder.decode which does not mutate its input.
    const first = chunks[0];
    return first ?? new Uint8Array(0);
  }
  const out = new Uint8Array(totalLength(chunks));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Project a sequence of chunks into stripped plain text.
 *
 * Overloads:
 *   - `projectChunksToText(chunks)` — concat + decode + strip.
 *   - `projectChunksToText(buffer)` — decode + strip (no concat needed).
 *
 * Both paths share the same `stripAnsi` implementation; the overload only
 * exists so callers that already own a single `Uint8Array` (e.g.
 * `ai-explain`'s byte-budget tail slicing) don't have to wrap it in an
 * array just to call the helper.
 */
export function projectChunksToText(chunks: readonly Uint8Array[]): string;
export function projectChunksToText(concatenated: Uint8Array): string;
export function projectChunksToText(
  input: readonly Uint8Array[] | Uint8Array,
): string {
  // Detect the single-buffer overload. `instanceof Uint8Array` can be false
  // across realms (Node's Buffer is a Uint8Array subclass from the Buffer
  // realm; jsdom creates TypedArrays in the window realm) — duck-type on the
  // `BYTES_PER_ELEMENT` marker that every TypedArray carries but arrays don't.
  if (!Array.isArray(input) && typeof (input as Uint8Array).byteLength === 'number' && (input as Uint8Array).BYTES_PER_ELEMENT === 1) {
    const buf = input as Uint8Array;
    if (buf.byteLength === 0) return '';
    return stripAnsi(DECODER.decode(buf));
  }
  const chunks = input as readonly Uint8Array[];
  if (chunks.length === 0) return '';
  const bytes = concat(chunks);
  if (bytes.byteLength === 0) return '';
  return stripAnsi(DECODER.decode(bytes));
}
