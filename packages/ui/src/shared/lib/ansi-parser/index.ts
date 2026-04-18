/**
 * Public entry for the streaming ANSI parser.
 *
 * Exported surface used by Agent A (block renderer) and by
 * `shared/ui/ansi-output/AnsiOutput`:
 *
 *   import { AnsiParser, BACKSPACE_MARKER } from '@ui/shared/lib/ansi-parser';
 *   import type { AnsiSpan, AnsiColor } from '@ui/shared/ui/ansi-output';
 *
 * Contract for the block store (Agent A):
 *   - One `AnsiParser` per block instance.
 *   - On each `pty_data` byte frame: `const spans = parser.feed(bytes);`
 *     append `spans` to the block's span list.
 *   - On block completion: `const tail = parser.flush();` append `tail`.
 *   - On rerun / reset: call `parser.reset()` before reuse.
 *
 * The parser emits no DOM — consumers pass the `AnsiSpan[]` to
 * `<AnsiOutput spans={...} />` for rendering, or serialize directly.
 *
 * `AnsiSpan` and `AnsiColor` are render-time concepts; their canonical
 * declarations live in `shared/ui/ansi-output`. Import them from there.
 */

export { AnsiParser } from './parser.js';
export { BACKSPACE_MARKER } from './types.js';
export type { AnsiModeEvent } from './types.js';
