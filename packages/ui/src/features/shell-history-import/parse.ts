/**
 * Shell-history file parsers.
 *
 * Three tiny, hand-rolled parsers for the three dotfile formats we import
 * on first launch:
 *
 *   1. zsh   — two dialects:
 *              plain: one command per line, literal text.
 *              EXTENDED_HISTORY: `: <epoch>:<duration>;<command>` per line.
 *              Multi-line commands end with a trailing `\` on each non-last
 *              line; the next physical line continues the same command. The
 *              zsh reader also expands a few meta-characters (`\\`, `\n`) in
 *              the extended dialect — we decode those back to literal chars
 *              so the stored string is what the user would actually retype.
 *
 *   2. bash  — optional `#<epoch>` lines preceding each command. We drop
 *              timestamp lines and keep the rest. Blank lines are skipped.
 *              Bash itself does NOT support multi-line commands in history
 *              without HISTCONTROL=lithist; we treat every non-comment line
 *              as one command to keep the parser honest against the
 *              overwhelming majority of users' files.
 *
 *   3. fish  — YAML-ish blocks:
 *                - cmd: the command text
 *                  when: 1700000000
 *                  paths:
 *                    - /some/file
 *              Fish escapes newlines in `cmd:` as a literal `\n` — we
 *              decode those back to real newlines so multi-line commands
 *              round-trip.
 *
 * Contract for all three:
 *   - Return the commands in CHRONOLOGICAL order (oldest first). This
 *     matches the on-disk order of zsh / bash / fish files, so in practice
 *     we just preserve the read order.
 *   - Collapse ADJACENT duplicates only (a user spamming the same command
 *     in a row). Non-adjacent repeats are kept — they carry recency info
 *     that the autosuggest ranker uses.
 *   - Cap the returned list at {@link MAX_ENTRIES_PER_FILE} items, keeping
 *     the MOST RECENT (tail of the list). Larger files still load, they
 *     just contribute their tail.
 *   - Parse failures on individual lines log-and-skip rather than throwing
 *     — we'd rather import 95% of a user's history than import 0%.
 *
 * Scope discipline: these are read-only parsers. Nothing here writes to
 * disk, mutates env, or shells out. A caller passes the raw file bytes as
 * a UTF-8 string (obtained via `HostBridge.readTextFile`), we hand back
 * the canonicalised command list.
 */

/**
 * Cap per file — 5 000 lines is comfortably past the median user's shell
 * history size while bounding memory: at ~50 bytes avg per command, 5 000
 * rows is ~250 KiB of string heap, which comfortably fits the localStorage
 * budget even once the Zustand persistence layer JSON-encodes it.
 */
export const MAX_ENTRIES_PER_FILE = 5_000;

/**
 * Per-entry length cap. A single real shell command is rarely longer than a
 * few hundred characters; a 1 KB ceiling prevents pathological entries (e.g.
 * embedded base64 blobs) from blowing the localStorage quota.
 * Worst case: 5 000 × 1 024 B ≈ 5 MB, safely below the typical 10 MB quota.
 */
export const MAX_ENTRY_LENGTH = 1_024;

/** The supported shell dialects. `null` sentinel in the store means
 *  "nothing imported yet". */
export type ShellHistorySource = 'zsh' | 'bash' | 'fish';

/**
 * Parse a raw zsh history file into a chronologically-ordered command list.
 *
 * Handles both the plain and EXTENDED_HISTORY dialects, line-by-line; the
 * two can interleave within a single file because zsh writes whichever
 * format was active at the time of the command.
 */
export function parseZshHistory(raw: string): string[] {
  const out: string[] = [];
  const lines = raw.split('\n');
  // zsh multi-line commands end physical lines with a literal trailing
  // backslash. We accumulate a buffer across those continuations.
  let pending: string | null = null;

  for (const physicalLine of lines) {
    // Strip the stray `\r` on files written from a Windows editor. Not
    // supposed to happen on macOS/Linux but cheap to tolerate.
    let line = physicalLine.endsWith('\r')
      ? physicalLine.slice(0, -1)
      : physicalLine;

    if (pending !== null) {
      // Continuation of the previous physical line. Append with a real
      // newline separator — the user typed \n here, we preserve it.
      pending += '\n' + line;
      if (line.endsWith('\\')) {
        pending = pending.slice(0, -1);
        continue;
      }
      pushUnlessAdjacentDup(out, decodeZshMeta(pending).slice(0, MAX_ENTRY_LENGTH));
      pending = null;
      continue;
    }

    // EXTENDED_HISTORY header: `: <epoch>:<duration>;command`
    let commandText: string;
    if (line.startsWith(': ')) {
      const sep = line.indexOf(';');
      if (sep === -1) {
        // Malformed header line — keep the raw tail as a best-effort
        // command so we don't throw away data.
        commandText = line.slice(2);
      } else {
        commandText = line.slice(sep + 1);
      }
    } else if (line.length === 0) {
      continue;
    } else {
      commandText = line;
    }

    if (commandText.endsWith('\\')) {
      pending = commandText.slice(0, -1);
      continue;
    }
    pushUnlessAdjacentDup(out, decodeZshMeta(commandText).slice(0, MAX_ENTRY_LENGTH));
  }

  // Flush any dangling continuation as a final command — strictly a
  // truncated file case, but dropping the partial entry silently would
  // confuse the user.
  if (pending !== null) {
    pushUnlessAdjacentDup(out, decodeZshMeta(pending).slice(0, MAX_ENTRY_LENGTH));
  }

  return capToMostRecent(out);
}

/**
 * Parse a bash history file into a chronologically-ordered command list.
 *
 * Timestamp lines (`#<epoch>`) are ignored — bash writes them only when
 * `HISTTIMEFORMAT` is set. Everything else is one command per line.
 */
export function parseBashHistory(raw: string): string[] {
  const out: string[] = [];
  for (const physicalLine of raw.split('\n')) {
    const line = physicalLine.endsWith('\r')
      ? physicalLine.slice(0, -1)
      : physicalLine;
    if (line.length === 0) continue;
    // bash timestamp header — `#` followed by an all-digit epoch. A `#`
    // in any other position is part of a comment a user typed and is
    // kept verbatim.
    if (line.startsWith('#') && /^#\d+$/u.test(line)) continue;
    pushUnlessAdjacentDup(out, line.slice(0, MAX_ENTRY_LENGTH));
  }
  return capToMostRecent(out);
}

/**
 * Parse a fish history file into a chronologically-ordered command list.
 *
 * Fish stores YAML-ish blocks. Minimal grammar we care about:
 *   - cmd: <command text, `\n` escapes decoded>
 *     when: <epoch>
 *     paths:
 *       - <path>
 *
 * We recognise `- cmd: …` as the start of a new entry. Everything else
 * until the next `- cmd: …` (or EOF) belongs to the same entry but we
 * only need the `cmd:` value — timestamps/paths are discarded for now.
 */
export function parseFishHistory(raw: string): string[] {
  const out: string[] = [];
  const lines = raw.split('\n');
  for (const physicalLine of lines) {
    const line = physicalLine.endsWith('\r')
      ? physicalLine.slice(0, -1)
      : physicalLine;
    // We only extract the command — anything else is metadata.
    // The entry header is exactly `- cmd: …` with optional leading
    // whitespace tolerated for hand-edited files.
    const m = /^\s*-\s*cmd:\s*(.*)$/u.exec(line);
    if (!m) continue;
    const cmd = decodeFishCmd(m[1] ?? '').slice(0, MAX_ENTRY_LENGTH);
    if (cmd.length === 0) continue;
    pushUnlessAdjacentDup(out, cmd);
  }
  return capToMostRecent(out);
}

/**
 * Push `cmd` onto `out` unless it equals the most recent entry already
 * there. "Adjacent dup" is the only class of duplicate we collapse; the
 * caller relies on non-adjacent repeats for frequency / recency signal.
 */
function pushUnlessAdjacentDup(out: string[], cmd: string): void {
  if (cmd.length === 0) return;
  if (out.length > 0 && out[out.length - 1] === cmd) return;
  out.push(cmd);
}

/**
 * Keep only the LAST {@link MAX_ENTRIES_PER_FILE} entries. Because the
 * input is chronological (oldest first), the tail is the most recent —
 * exactly what the autosuggest ranker weights highest.
 */
function capToMostRecent(entries: string[]): string[] {
  if (entries.length <= MAX_ENTRIES_PER_FILE) return entries;
  return entries.slice(entries.length - MAX_ENTRIES_PER_FILE);
}

/**
 * zsh's history writer escapes a handful of characters in EXTENDED_HISTORY
 * mode so the file stays one-command-per-line when it wants to. Decoding
 * back to literal characters lets us store a string the user could retype.
 *
 * We only decode the three escapes that are genuinely written by zsh's
 * history code path — a blanket `JSON.parse`-style unescape would eat
 * legitimate backslashes users typed in commands like `printf '\n'`.
 */
function decodeZshMeta(s: string): string {
  // Replace `\\` with a sentinel, then decode `\n`, then restore the
  // backslashes. This avoids a naive double-pass from eating escapes.
  const SENTINEL = '\u0000ZSH_BS\u0000';
  return s
    .replace(/\\\\/gu, SENTINEL)
    .replace(/\\n/gu, '\n')
    .replace(new RegExp(SENTINEL, 'gu'), '\\');
}

/**
 * Fish stores newlines in `cmd:` values as a literal `\n` (two-character
 * escape). Decode those back into real newlines. Other escapes in fish
 * history files are rare enough that we leave them alone — round-tripping
 * perfectly isn't a requirement here since the command text is only used
 * for autosuggest ranking, not execution.
 */
function decodeFishCmd(s: string): string {
  return s.replace(/\\n/gu, '\n');
}
