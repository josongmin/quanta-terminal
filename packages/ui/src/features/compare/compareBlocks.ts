/**
 * compareBlocks — the pure "compute a diff + deltas" function powering the
 * Compare panel.
 *
 * Responsibilities
 * ----------------
 *   - Decode each block's raw output chunks into text (UTF-8, non-fatal so a
 *     half-written multi-byte sequence at the end of the stream doesn't
 *     throw).
 *   - Strip ANSI control sequences from the text before line-diffing. The
 *     spec asks us to verify text-only compare — colors are display-only and
 *     must not affect line equality. We run a lightweight regex strip here
 *     instead of reaching into `shared/lib/ansi-parser` because the parser
 *     is stateful (per-block span accumulator) and plumbing it through the
 *     compare flow would couple widget-side parsing to the pure diff.
 *   - Call `diffLines` to produce the line trace, and compute the three
 *     deltas the header chips render (duration, exit code, bytes).
 *
 * This function is SIDE-EFFECT-FREE — no store reads, no DOM touches, no
 * timers. The caller (`openCompareFromBlock`) pulls a snapshot of both
 * blocks before invocation so the panel's render is stable.
 */

import type { Block } from '../../entities/block/index.js';
import { concatChunks } from '../../entities/block/index.js';
import { diffLines, type DiffResult } from '../../shared/lib/diff/index.js';

export interface CompareDeltas {
  /**
   * Duration delta in milliseconds — right minus left. A running block (no
   * `completedAt`) is measured against `now` so the header shows something
   * sensible rather than `null`; the Compare panel only opens on at least a
   * completed pair in practice but we don't want to crash if the user races
   * us.
   */
  readonly durationDeltaMs: number;
  readonly leftDurationMs: number;
  readonly rightDurationMs: number;
  /** Left and right exit codes (may be null for running / error). */
  readonly leftExitCode: number | null;
  readonly rightExitCode: number | null;
  /** Byte delta — right minus left. Positive = larger new output. */
  readonly bytesDeltaBytes: number;
  readonly leftBytes: number;
  readonly rightBytes: number;
  /** True when the two commands differ — the header flags it so users notice. */
  readonly commandsDiffer: boolean;
}

export interface CompareView {
  readonly left: Block;
  readonly right: Block;
  /** Decoded + stripped text, exactly what was fed into the diff. */
  readonly leftText: string;
  readonly rightText: string;
  /**
   * Raw (ANSI-preserving) lines. `diffLines` runs over the stripped text so
   * color differences don't register as changes, but the panel renders each
   * visible line with its ORIGINAL ANSI styling intact. We index into these
   * arrays by `DiffLine.leftIdx` / `rightIdx` at render time. Lengths match
   * `DiffResult.leftLineCount` / `rightLineCount`.
   */
  readonly leftRawLines: readonly string[];
  readonly rightRawLines: readonly string[];
  readonly diff: DiffResult;
  readonly deltas: CompareDeltas;
}

// Strip CSI / OSC / ESC sequences so ANSI-colored lines equal their
// uncolored counterparts. We intentionally allow the empty-bytes unicode
// regex dialect — all ANSI escapes live in the 7-bit range. The three
// patterns cover: CSI (ESC `[` params final), OSC (ESC `]` …BEL/ESC\\),
// and bare single-byte ESC sequences we don't care about.
const ANSI_STRIP_RE = new RegExp(
  [
    // CSI: ESC [ ... final (@ .. ~)
    '\\x1B\\[[0-?]*[ -/]*[@-~]',
    // OSC: ESC ] ... (BEL | ESC \\)
    '\\x1B\\][^\\x07\\x1B]*(?:\\x07|\\x1B\\\\)',
    // Two-byte ESC sequences like RIS, charset selection.
    '\\x1B[@-Z\\\\-_]',
  ].join('|'),
  'gu',
);

const TEXT_DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

/** Decode a block's output preserving ANSI sequences. */
export function decodeRawOutput(block: Block): string {
  if (block.outputChunks.length === 0) return '';
  const bytes = concatChunks(block.outputChunks);
  return TEXT_DECODER.decode(bytes);
}

/** Decode + strip a block's output. Exposed for tests + reuse by the panel. */
export function decodeStrippedOutput(block: Block): string {
  return decodeRawOutput(block).replace(ANSI_STRIP_RE, '');
}

/** Strip ANSI escapes from an arbitrary string — exposed so callers can
 *  normalize a single raw line (e.g. for tooltip text) without re-decoding. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_STRIP_RE, '');
}

function splitRawLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function byteLen(block: Block): number {
  let n = 0;
  for (const c of block.outputChunks) n += c.byteLength;
  return n;
}

function durationMs(block: Block, now: number): number {
  const end = block.completedAt ?? now;
  return Math.max(0, end - block.startedAt);
}

/**
 * Produce the full CompareView for a pair. Takes `now` as an explicit
 * parameter so tests can feed a fixed clock without mocking Date.
 */
export function compareBlocks(
  left: Block,
  right: Block,
  now: number = Date.now(),
): CompareView {
  const leftRaw = decodeRawOutput(left);
  const rightRaw = decodeRawOutput(right);
  const leftText = leftRaw.replace(ANSI_STRIP_RE, '');
  const rightText = rightRaw.replace(ANSI_STRIP_RE, '');
  const leftRawLines = splitRawLines(leftRaw);
  const rightRawLines = splitRawLines(rightRaw);
  const diff = diffLines(leftText, rightText);
  const leftBytes = byteLen(left);
  const rightBytes = byteLen(right);
  const leftDurationMs = durationMs(left, now);
  const rightDurationMs = durationMs(right, now);
  const deltas: CompareDeltas = {
    durationDeltaMs: rightDurationMs - leftDurationMs,
    leftDurationMs,
    rightDurationMs,
    leftExitCode: left.exitCode,
    rightExitCode: right.exitCode,
    bytesDeltaBytes: rightBytes - leftBytes,
    leftBytes,
    rightBytes,
    commandsDiffer: left.command !== right.command,
  };
  return {
    left,
    right,
    leftText,
    rightText,
    leftRawLines,
    rightRawLines,
    diff,
    deltas,
  };
}
