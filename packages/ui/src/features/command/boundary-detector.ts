/**
 * Boundary detector port + mock implementation.
 *
 * Phase 2 uses the mock bridge's prompt-suffix as the block boundary marker.
 * Real shells will replace this with an OSC 133 D detector. The port stays
 * the same; the router swaps implementations without code churn.
 *
 * Why this is stateful
 * --------------------
 * PTY chunks are not framed. A multi-byte terminator can land with its
 * first byte at the end of chunk N and the rest at the start of chunk N+1.
 * A stateless suffix-match on each chunk (the original Phase-2 code) misses
 * that case and leaks the next block's leading bytes into the closing block.
 *
 * The detector keeps a small tail ringbuffer sized to the terminator length
 * minus one — the maximum prefix that could be "pending" in the previous
 * chunk. On each feed we logically concat the carried prefix with the new
 * chunk, search for the terminator, and if found return the pre-terminator
 * bytes as `preBoundary`. Any unmatched tail stays in the buffer for the
 * next call.
 *
 * `exitCode` is null for the mock — the mock does not carry one. The router
 * uses 0 on a mock boundary and the real pty_exit code on session exit.
 */

import { MOCK_PROMPT_BYTES } from '@quanta/host-common';

export interface BoundaryFeedResult {
  /** Bytes that belong to the block that is closing (when hadBoundary) or
   *  the currently-open block (when !hadBoundary). Empty when the chunk
   *  contained nothing but carried-over terminator bytes. */
  readonly preBoundary: Uint8Array;
  /** True iff this feed produced a complete terminator match. */
  readonly hadBoundary: boolean;
  /** Exit code carried by the boundary signal. Null for the mock (it does
   *  not transmit one); future OSC 133 D impl will parse a value. */
  readonly exitCode: number | null;
}

export interface BoundaryDetector {
  /**
   * Consume a decoded PTY chunk. Returns the bytes to forward to the active
   * block and whether a boundary was observed. Internal state is advanced
   * regardless — the same detector instance must be used across chunks for
   * the same block.
   */
  feed(chunk: Uint8Array): BoundaryFeedResult;
}

/**
 * Byte-slice equality helper: does `haystack[start..start+needle.length]`
 * equal `needle`? Out-of-range starts return false.
 */
function matchesAt(haystack: Uint8Array, start: number, needle: Uint8Array): boolean {
  if (start + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[start + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Factory for the mock-prompt detector. Reads terminator bytes from
 * host-common so producer (mock-bridge) and consumer (this detector)
 * cannot drift.
 */
export function createMockBoundaryDetector(): BoundaryDetector {
  const terminator = MOCK_PROMPT_BYTES;
  const maxCarry = terminator.length - 1;
  // Carried tail from previous chunk — up to `maxCarry` bytes whose
  // suffix could still participate in a cross-chunk terminator match.
  let carry: Uint8Array = new Uint8Array(0);

  return {
    feed(chunk: Uint8Array): BoundaryFeedResult {
      // Concatenate carry + chunk into a working buffer. We can't search
      // across the boundary without a joined view, and carry is bounded
      // so this allocation is small (≤ terminator.length + chunk.length).
      let buffer: Uint8Array;
      if (carry.length === 0) {
        buffer = chunk;
      } else {
        buffer = new Uint8Array(carry.length + chunk.length);
        buffer.set(carry, 0);
        buffer.set(chunk, carry.length);
      }

      // Search for the terminator anywhere in the combined buffer. We
      // match at the earliest occurrence so a command whose output ends
      // with the terminator — the only legitimate case — closes cleanly.
      // If the terminator appears mid-chunk followed by more bytes, we
      // still treat the first match as the boundary; the trailing bytes
      // are discarded (no active block to route them to anyway, and the
      // caller will open a new block before more data arrives).
      for (let i = 0; i + terminator.length <= buffer.length; i += 1) {
        if (matchesAt(buffer, i, terminator)) {
          const pre = buffer.slice(0, i);
          // A boundary consumes the carry — nothing after the terminator
          // belongs to the now-closing block, and the next block starts
          // from a fresh state.
          carry = new Uint8Array(0);
          return { preBoundary: pre, hadBoundary: true, exitCode: null };
        }
      }

      // No full match. Find the longest suffix of `buffer` that matches a
      // PREFIX of the terminator — only those bytes could complete a
      // cross-chunk terminator on the next feed. Carrying any more would
      // stall normal output waiting for a boundary that will never come.
      //
      // Example: terminator = "\x1b[36m$\x1b[0m " (9 bytes). If a chunk
      // ends with "\x1b[36m" (5 bytes) we carry those 5 bytes; the rest
      // goes downstream now. If a chunk ends with "foo" we carry nothing.
      let keep = Math.min(buffer.length, maxCarry);
      while (keep > 0) {
        let ok = true;
        for (let i = 0; i < keep; i += 1) {
          if (buffer[buffer.length - keep + i] !== terminator[i]) {
            ok = false;
            break;
          }
        }
        if (ok) break;
        keep -= 1;
      }
      const emittedLength = buffer.length - keep;
      const emitted = buffer.slice(0, emittedLength);
      carry = buffer.slice(emittedLength);
      return { preBoundary: emitted, hadBoundary: false, exitCode: null };
    },
  };
}
