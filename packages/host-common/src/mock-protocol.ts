/**
 * Mock bridge protocol constants.
 *
 * The in-browser mock PTY terminates every command's output with a single
 * prompt glyph — a cyan `$` followed by a space. The UI's output router
 * uses that suffix as a Phase-2 boundary marker: when it arrives we close
 * the active block and drop the terminator so it never leaks into block
 * content. Real shells will replace this with OSC 133 D.
 *
 * These bytes are the wire contract between the mock bridge (producer)
 * and the command router's boundary detector (consumer). Both sides MUST
 * import from here — that is the whole reason this module exists. Any
 * drift between producer and consumer would silently misbucket output.
 */

/** The mock prompt string as the shell writes it. UI string-matching code
 *  (tests, display helpers) consumes this form. */
export const MOCK_PROMPT_STRING = '\u001b[36m$\u001b[0m ';

/** The mock prompt's UTF-8 bytes. Precomputed at module load so per-chunk
 *  byte compares are allocation-free. Never mutate — consumers treat this
 *  as read-only. */
export const MOCK_PROMPT_BYTES: Uint8Array = new TextEncoder().encode(MOCK_PROMPT_STRING);
