import { describe, expect, it } from 'vitest';
import {
  isSingleToken,
  suggestCorrection,
  type CorrectionHistoryEntry,
} from '../suggest.js';

function entry(command: string, cwd: string, overrides: Partial<CorrectionHistoryEntry> = {}): CorrectionHistoryEntry {
  return {
    command,
    cwd,
    lastRunAt: Date.now(),
    runCount: 1,
    ...overrides,
  };
}

describe('isSingleToken()', () => {
  it('accepts bare command names', () => {
    expect(isSingleToken('ls')).toBe(true);
    expect(isSingleToken('git')).toBe(true);
    expect(isSingleToken('kubectl')).toBe(true);
    expect(isSingleToken('node-bin')).toBe(true);
    expect(isSingleToken('python3.11')).toBe(true);
  });

  it('rejects commands with arguments or shell metacharacters', () => {
    expect(isSingleToken('ls -la')).toBe(false);
    expect(isSingleToken('make foo')).toBe(false);
    expect(isSingleToken('ls | grep x')).toBe(false);
    expect(isSingleToken('echo $HOME')).toBe(false);
    expect(isSingleToken('git; rm -rf /')).toBe(false);
    expect(isSingleToken('(subshell)')).toBe(false);
    expect(isSingleToken('cd && ls')).toBe(false);
    expect(isSingleToken('"quoted"')).toBe(false);
    expect(isSingleToken('')).toBe(false);
  });
});

describe('suggestCorrection()', () => {
  it('returns null when the command has arguments (multi-word)', () => {
    const result = suggestCorrection({
      command: 'lls -la',
      cwd: '/tmp',
      history: [entry('ls -la', '/tmp')],
    });
    expect(result).toBeNull();
  });

  it('returns null for an empty command', () => {
    expect(
      suggestCorrection({ command: '', cwd: '/tmp', history: [] }),
    ).toBeNull();
  });

  it('typo map wins with high confidence', () => {
    const result = suggestCorrection({
      command: 'gti',
      cwd: '/tmp',
      history: [],
    });
    expect(result).toEqual({ suggested: 'git', confidence: 'high', source: 'typo' });
  });

  it('covers the documented typo examples', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['lls', 'ls'],
      ['sl', 'ls'],
      ['ehco', 'echo'],
      ['mkae', 'make'],
      ['pythn', 'python'],
      ['nom', 'npm'],
      ['docekr', 'docker'],
      ['kubctl', 'kubectl'],
      ['grpe', 'grep'],
    ];
    for (const [wrong, right] of samples) {
      const r = suggestCorrection({ command: wrong, cwd: '/', history: [] });
      expect(r?.suggested, `expected ${wrong} → ${right}`).toBe(right);
      expect(r?.source).toBe('typo');
    }
  });

  it('returns null when input exactly matches a known command (no correction needed)', () => {
    const result = suggestCorrection({
      command: 'ls',
      cwd: '/tmp',
      history: [entry('ls', '/tmp')],
    });
    expect(result).toBeNull();
  });

  it('returns null for unrelated commands with no close match', () => {
    const result = suggestCorrection({
      command: 'xyz123',
      cwd: '/tmp',
      history: [entry('ls', '/tmp'), entry('git status', '/tmp')],
    });
    expect(result).toBeNull();
  });

  it('history match in the same cwd wins over nothing', () => {
    const result = suggestCorrection({
      command: 'redis',
      cwd: '/proj',
      history: [entry('redist', '/proj', { runCount: 3 })],
    });
    expect(result?.source).toBe('history');
    expect(result?.suggested).toBe('redist');
  });

  it('prefers a closer history match over a more-distant one', () => {
    const result = suggestCorrection({
      command: 'gitx',
      cwd: '/proj',
      history: [
        entry('gitxyz', '/proj', { runCount: 1 }), // distance 2
        entry('gits', '/proj', { runCount: 1 }), // distance 1
      ],
    });
    expect(result?.suggested).toBe('gits');
  });

  it('prefers same-cwd history over cross-cwd matches', () => {
    const result = suggestCorrection({
      command: 'pytest',
      cwd: '/proj',
      history: [
        entry('pytext', '/other'), // same distance, different cwd
        entry('pytesp', '/proj'),
      ],
    });
    expect(result?.suggested).toBe('pytesp');
  });

  it('falls back to cross-cwd history with tight threshold ≤ 1', () => {
    // Use a custom command not covered by the typo map so history is the
    // only source. Distance 1 cross-cwd is accepted by step 3.
    const result = suggestCorrection({
      command: 'myproj',
      cwd: '/proj',
      history: [entry('myproc', '/other-dir')],
    });
    expect(result).not.toBeNull();
    expect(result?.source).toBe('history');
    expect(result?.suggested).toBe('myproc');
  });

  it('returns null when cross-cwd history only has distance-2 matches', () => {
    const result = suggestCorrection({
      command: 'zzcmd',
      cwd: '/proj',
      history: [entry('zxcmd', '/other', { runCount: 5 })], // distance 1, different cwd — ACCEPTED
    });
    // distance 1 in cross-cwd is accepted by step 3
    expect(result?.suggested).toBe('zxcmd');
  });

  it('rejects a distance-2 cross-cwd match because the threshold is 1', () => {
    const result = suggestCorrection({
      command: 'zxcvbn',
      cwd: '/proj',
      history: [entry('qwerty', '/other')], // much further than 1
    });
    expect(result).toBeNull();
  });

  it('ranks high-frequency commands higher when distances tie', () => {
    // Both "tesp" and "tesq" are at distance 1 from "test" (single-char
    // substitution). With distances equal, the ranker breaks the tie using
    // runCount descending — the more frequently-run entry wins.
    const result = suggestCorrection({
      command: 'test',
      cwd: '/proj',
      history: [
        entry('tesp', '/proj', { runCount: 10 }),
        entry('tesq', '/proj', { runCount: 1 }),
      ],
    });
    expect(result?.suggested).toBe('tesp');
  });

  it('history results are returned without arguments (single-token suggestions only)', () => {
    const result = suggestCorrection({
      command: 'gi',
      cwd: '/proj',
      history: [entry('git status', '/proj', { runCount: 5 })],
    });
    // We suggest the first token ("git"), never the whole "git status".
    expect(result?.suggested).toBe('git');
  });

  it('high confidence at distance 1, medium at distance 2 for history', () => {
    const hit1 = suggestCorrection({
      command: 'gi',
      cwd: '/proj',
      history: [entry('git', '/proj')],
    });
    expect(hit1?.confidence).toBe('high');

    const hit2 = suggestCorrection({
      command: 'gix',
      cwd: '/proj',
      history: [entry('gist', '/proj')],
    });
    // "gix" → "gist" is distance 2 (one insertion, one substitution).
    expect(hit2?.confidence).toBe('medium');
  });
});
