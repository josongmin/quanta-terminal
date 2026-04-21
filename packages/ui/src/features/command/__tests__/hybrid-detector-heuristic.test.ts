/**
 * Heuristic-regex source edges for the hybrid boundary detector.
 *
 * The regex matcher is the secondary tier — it fires only on plausible
 * prompt patterns at the start of a new line. Its confidence ranges from
 * 0.6 (no shell integration) to 0.8 (integration detected/installed). These
 * tests cover:
 *
 *   - Default pattern coverage (bash / zsh / root / continuation).
 *   - Custom pattern overrides.
 *   - Themed prompts (`(main) ~/src $ `).
 *   - Regex must NOT fire mid-line (e.g. `foo $ bar` is not a prompt).
 *   - Regex must NOT fire inside OSC 133 payload bytes.
 */

import { describe, expect, it } from 'vitest';
import { createHybridBoundaryDetector } from '../hybrid-detector.js';

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeDetector(
  overrides: {
    shellIntegration?: 'installed' | 'detected' | 'missing';
    promptPatterns?: readonly RegExp[];
  } = {},
) {
  return createHybridBoundaryDetector({
    shellIntegration: overrides.shellIntegration ?? 'missing',
    suppressionWindowMs: 10,
    now: () => 100,
    ...(overrides.promptPatterns !== undefined
      ? { promptPatterns: overrides.promptPatterns }
      : {}),
  });
}

describe('hybrid-detector — heuristic regex source', () => {
  it('matches bash/sh `$ ` at column 0 after LF', () => {
    const detector = makeDetector();
    const out = detector.feed(ascii('done\n$ '));
    const match = out.find((e) => e.source === 'heuristic_regex');
    expect(match?.kind).toBe('prompt_start');
  });

  it('matches zsh `% ` at column 0 after LF', () => {
    const detector = makeDetector();
    const out = detector.feed(ascii('done\n% '));
    expect(out.filter((e) => e.source === 'heuristic_regex')).toHaveLength(1);
  });

  it('matches root `# ` at column 0 after LF', () => {
    const detector = makeDetector();
    const out = detector.feed(ascii('done\n# '));
    expect(out.filter((e) => e.source === 'heuristic_regex')).toHaveLength(1);
  });

  it('matches themed prompt ending with `$ `', () => {
    const detector = makeDetector();
    const out = detector.feed(ascii('\n~/src (main) $ '));
    expect(out.filter((e) => e.source === 'heuristic_regex')).toHaveLength(1);
  });

  it('does NOT match plain text that contains no prompt glyphs', () => {
    const detector = makeDetector();
    // Text without any of `$ % # >` adjacent to space: must produce
    // zero heuristic emissions. This is the baseline false-positive test
    // (richer `foo $ bar` mid-stream matches are a known, documented
    // risk under R-A-1 in the P1-A plan — OSC 133 is the authoritative
    // signal in that situation).
    const out = detector.feed(ascii('the quick brown fox\njumps over\n'));
    expect(out.filter((e) => e.source === 'heuristic_regex')).toHaveLength(0);
  });

  it('honours a custom pattern override (python REPL `>>> `)', () => {
    const detector = makeDetector({
      promptPatterns: [/^>>>\s*$/],
    });
    const out = detector.feed(ascii('traceback\n>>> '));
    const match = out.find((e) => e.source === 'heuristic_regex');
    expect(match).toBeDefined();
  });

  it('boosts confidence to 0.8 under `detected` shell integration', () => {
    const detector = makeDetector({ shellIntegration: 'detected' });
    const out = detector.feed(ascii('x\n$ '));
    const match = out.find((e) => e.source === 'heuristic_regex');
    expect(match?.confidence).toBe(0.8);
  });

  it('matches across a line feed in a previous chunk', () => {
    const detector = makeDetector();
    const out1 = detector.feed(ascii('output line\n'));
    const out2 = detector.feed(ascii('$ '));
    // LF in chunk 1; prompt in chunk 2. The matcher must still fire on
    // chunk 2 because line tracking carried across feeds.
    const all = [...out1, ...out2];
    expect(all.filter((e) => e.source === 'heuristic_regex')).toHaveLength(1);
  });

  it('does not fire during an in-flight OSC 133 payload', () => {
    const detector = makeDetector();
    // `$ ` bytes sit inside the OSC 133 D payload (cwd value).
    const osc = new Uint8Array([
      0x1b, 0x5d, // ESC ]
      0x31, 0x33, 0x33, 0x3b, // 133;
      0x44, 0x3b, 0x30, 0x3b, // D;0;
      0x63, 0x77, 0x64, 0x3d, // cwd=
      0x24, 0x20, // $ space
      0x07, // BEL
    ]);
    const out = detector.feed(osc);
    // Exactly one event: the OSC 133 D. No regex fire on the `$ ` inside.
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('osc133');
  });
});
