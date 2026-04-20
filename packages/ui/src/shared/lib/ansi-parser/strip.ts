/**
 * `stripAnsi` — remove ANSI escape sequences + bare C0 control bytes from a
 * decoded string so it renders (or copies) as plain text.
 *
 * Why live in `shared/lib/ansi-parser/` and not its own slice:
 * ---------------------------------------------------------
 * Stripping is the lightweight cousin of full parsing — both owned by the
 * "ANSI interpretation" concern. The heavyweight `AnsiParser` is for the
 * streaming render path (it emits styled spans). `stripAnsi` is for the
 * handful of paths that need a plain-text projection of a block's bytes:
 *
 *   - Collapsed BlockCard peek row (one line, no styling goal).
 *   - Clipboard copy of output (users paste into editors).
 *   - Markdown / text export.
 *   - Compare-panel diff normalization.
 *   - History search normalization.
 *
 * Centralizing the regex here (instead of duplicating it in every caller)
 * closes the drift window where we had THREE different strip implementations
 * across `features/block/export.ts`, `features/compare/compareBlocks.ts`, and
 * ad-hoc callers. The expanded BlockCard body keeps using `AnsiParser` — the
 * strip path is purely for downstream text consumers.
 *
 * Coverage
 * --------
 * - CSI:        `ESC [ params intermediate final` — SGR, cursor ops, ED/EL …
 * - OSC:        `ESC ] payload (BEL | ESC\)` — titles, 133, 633, OSC 8.
 * - DCS:        `ESC P payload ESC\` — device control strings.
 * - CHARSET:    `ESC ( X` / `ESC ) X` — G0/G1 character set selects.
 * - TWO_BYTE:   `ESC <letter>` — RIS, reverse index, etc.
 * - C0 (non-whitespace): `\x00-\x08 \x0B \x0C \x0E-\x1F \x7F`
 *   NOTE we deliberately KEEP `\t` (0x09), `\n` (0x0A), `\r` (0x0D) because
 *   text consumers want their whitespace. The zsh `PROMPT_EOL_MARK` symptom
 *   that motivated this helper is precisely a literal `ESC` showing up
 *   because none of these paths ran a stripper.
 */

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
// eslint-disable-next-line no-control-regex
const DCS = /\x1bP[^\x1b]*\x1b\\/gu;
// eslint-disable-next-line no-control-regex
const CHARSET = /\x1b[()*+][A-Za-z0-9]/gu;
// eslint-disable-next-line no-control-regex
const TWO_BYTE = /\x1b[@-Z\\-_]/gu;
// Catch-all for bare two-byte escapes we don't model (RIS `ESC c`, save /
// restore cursor `ESC 7` / `ESC 8`, line-feed variants, …). Runs LAST so
// the structured strippers above consume their specific payloads first;
// this mops up any remaining `ESC <printable-byte>` pair. The payload byte
// range `[ -~]` matches the ANSI "final byte" class (0x20..0x7e) so we
// don't greedily chew into payloads that were legitimately stripped by the
// structured patterns.
// eslint-disable-next-line no-control-regex
const BARE_ESC = /\x1b[ -~]/gu;
// eslint-disable-next-line no-control-regex
const C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu;

/**
 * zsh `PROMPT_EOL_MARK` — when a command's stdout does not end in a
 * newline, zsh emits a reverse-video sigil (default `%`) before drawing
 * the next prompt so the user sees "this output was missing an EOL".
 * The literal bytes look like:
 *
 *     \r \x1b[1m\x1b[7m % \x1b[27m\x1b[1m\x1b[0m  \r  (trailing spaces + CR)
 *
 * Plain `stripAnsi` removes the SGR brackets but leaves the bare `%` +
 * trailing whitespace, which is what the user sees as a floating `%`
 * glyph at the end of otherwise-clean output. We match the FULL pattern
 * (SGR-reverse on → single sigil → SGR-reverse off) and drop the whole
 * thing before the generic strippers run, so the sigil does not leak.
 *
 * Matched sigils: `%` (zsh), `#` (root zsh), `$` (bash variants), `>`
 * (tcsh). The inner char set is intentionally small so we don't eat
 * legitimate reverse-video output (e.g. a highlighted search hit in a
 * TUI).
 */
// The SGR payload may be ONE CSI (`\x1b[7m%\x1b[27m`) or a chain
// (`\x1b[1m\x1b[7m%\x1b[27m\x1b[22m` — the zsh default `%B%S%#%s%b`).
// We require ≥1 CSI on each side so we don't eat a bare `%` literal.
// eslint-disable-next-line no-control-regex
const EOL_MARK = /(?:\x1b\[[0-?]*[ -/]*m)+[%#$>](?:\x1b\[[0-?]*[ -/]*m)+/gu;

/**
 * Remove ANSI escape sequences and non-whitespace C0 control bytes.
 *
 * Safe to call on an empty string — returns empty. Idempotent: `stripAnsi(stripAnsi(s)) === stripAnsi(s)`.
 */
export function stripAnsi(input: string): string {
  if (input.length === 0) return input;
  return input
    .replace(EOL_MARK, '')
    .replace(OSC, '')
    .replace(DCS, '')
    .replace(CSI, '')
    .replace(CHARSET, '')
    .replace(TWO_BYTE, '')
    .replace(BARE_ESC, '')
    .replace(C0, '');
}
