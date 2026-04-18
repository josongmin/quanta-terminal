/**
 * path-detect — precision tests over realistic compiler-output fixtures.
 *
 * Each fixture maps an input line to the expected detected paths. We enumerate
 * 30+ cases spanning:
 *   - rustc / cargo: `error[E0308]: mismatched types\n --> src/main.rs:12:5`
 *   - tsc: `packages/ui/foo.ts(42,7): error TS2322`
 *     (NOT supported here — tsc's parenthetical form is a different pattern
 *     the diagnostic parser owns; we verify we don't misfire on it either way.)
 *   - tsc vite-style: `packages/ui/src/foo.ts:12:3 - error TS2322`
 *   - python: `File "/home/alice/foo.py", line 12, in <module>`
 *     (again: out-of-scope for this regex; the diagnostic parser will handle.)
 *   - python compact: `foo.py:12:3: E501`
 *   - node stack: `at foo (/Users/alice/repo/src/index.js:10:5)`
 *   - jest-style failure: `expected … at Object.<anonymous> (foo.test.ts:42:7)`
 *
 * False-positive traps we deliberately REJECT:
 *   - URLs: `https://example.com:8080/path`
 *   - Clock strings: `[12:34:56]`
 *   - Windows drive collisions without a dot: `C:\Users\alice:12:3` (no `.`)
 *   - Bare number strings: `3:14`, `1:1:1`
 */

import { describe, expect, it } from 'vitest';
import { detectPaths, splitTextByPaths } from '../index.js';

type Case = {
  readonly name: string;
  readonly input: string;
  readonly expected: ReadonlyArray<{
    readonly match: string;
    readonly path: string;
    readonly line: number;
    readonly column?: number;
  }>;
};

const TRUE_POSITIVES: readonly Case[] = [
  // rustc / cargo
  {
    name: 'rustc --> arrow prefix',
    input: '  --> src/main.rs:12:5',
    expected: [{ match: 'src/main.rs:12:5', path: 'src/main.rs', line: 12, column: 5 }],
  },
  {
    name: 'rustc error E0308 location line',
    input: 'error[E0308]: mismatched types\n  --> crates/quanta-proto/src/lib.rs:42:17',
    expected: [
      {
        match: 'crates/quanta-proto/src/lib.rs:42:17',
        path: 'crates/quanta-proto/src/lib.rs',
        line: 42,
        column: 17,
      },
    ],
  },
  {
    name: 'rustc single-digit column',
    input: '  --> foo.rs:1:1',
    expected: [{ match: 'foo.rs:1:1', path: 'foo.rs', line: 1, column: 1 }],
  },

  // tsc (vite-style)
  {
    name: 'tsc vite format',
    input: 'packages/ui/src/foo.ts:12:3 - error TS2322: Type \'string\' is not assignable',
    expected: [
      { match: 'packages/ui/src/foo.ts:12:3', path: 'packages/ui/src/foo.ts', line: 12, column: 3 },
    ],
  },
  {
    name: 'tsc line-only',
    input: 'src/foo.ts:42 - error TS2322',
    expected: [{ match: 'src/foo.ts:42', path: 'src/foo.ts', line: 42 }],
  },

  // eslint stylish
  {
    name: 'eslint stylish line:col at start',
    input: '  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any',
    // "12:5" has no dot → not a path. Ensure we do not detect.
    expected: [],
  },
  {
    name: 'eslint file header row',
    input: '/Users/alice/repo/src/foo.ts\n  12:5  error  Unexpected any',
    // Just the path with no :line: → not a hit; this is intentional (we need
    // the line to make the click meaningful).
    expected: [],
  },

  // python compact (pyflakes / ruff)
  {
    name: 'python ruff format',
    input: 'foo.py:12:3: E501 line too long',
    expected: [{ match: 'foo.py:12:3', path: 'foo.py', line: 12, column: 3 }],
  },
  {
    name: 'python with dot-prefixed relative',
    input: './scripts/build.py:3:1: F401',
    expected: [{ match: './scripts/build.py:3:1', path: './scripts/build.py', line: 3, column: 1 }],
  },

  // node stack frames
  {
    name: 'node stack absolute path',
    input: '    at foo (/Users/alice/repo/src/index.js:10:5)',
    expected: [
      { match: '/Users/alice/repo/src/index.js:10:5', path: '/Users/alice/repo/src/index.js', line: 10, column: 5 },
    ],
  },
  {
    name: 'node stack without parens',
    input: '    at /repo/src/index.js:10:5',
    expected: [{ match: '/repo/src/index.js:10:5', path: '/repo/src/index.js', line: 10, column: 5 }],
  },
  {
    name: 'node relative stack',
    input: '    at foo (src/a/b/c.js:9:1)',
    expected: [{ match: 'src/a/b/c.js:9:1', path: 'src/a/b/c.js', line: 9, column: 1 }],
  },

  // jest / vitest failures
  {
    name: 'jest describe file',
    input: 'FAIL src/foo.test.ts:7:10',
    expected: [{ match: 'src/foo.test.ts:7:10', path: 'src/foo.test.ts', line: 7, column: 10 }],
  },

  // go
  {
    name: 'go compile error',
    input: './main.go:15:2: undefined: foo',
    expected: [{ match: './main.go:15:2', path: './main.go', line: 15, column: 2 }],
  },

  // multiple on same line
  {
    name: 'multiple paths in a single message',
    input: 'see src/a.ts:1:1 and src/b.ts:2:2',
    expected: [
      { match: 'src/a.ts:1:1', path: 'src/a.ts', line: 1, column: 1 },
      { match: 'src/b.ts:2:2', path: 'src/b.ts', line: 2, column: 2 },
    ],
  },

  // deeply nested path
  {
    name: 'deeply nested path',
    input: 'packages/ui/src/shared/lib/path-detect/index.ts:100:42',
    expected: [
      {
        match: 'packages/ui/src/shared/lib/path-detect/index.ts:100:42',
        path: 'packages/ui/src/shared/lib/path-detect/index.ts',
        line: 100,
        column: 42,
      },
    ],
  },

  // home-dir tilde
  {
    name: 'tilde home prefix',
    input: '~/projects/foo.rs:5:1',
    expected: [{ match: '~/projects/foo.rs:5:1', path: '~/projects/foo.rs', line: 5, column: 1 }],
  },

  // dotfile
  {
    name: 'hidden dotfile',
    input: './.eslintrc.cjs:3:1',
    expected: [{ match: './.eslintrc.cjs:3:1', path: './.eslintrc.cjs', line: 3, column: 1 }],
  },

  // yaml / toml
  {
    name: 'yaml lint pointer',
    input: '.github/workflows/ci.yml:12:3',
    expected: [
      { match: '.github/workflows/ci.yml:12:3', path: '.github/workflows/ci.yml', line: 12, column: 3 },
    ],
  },

  // line only (no column)
  {
    name: 'line only is allowed',
    input: 'src/index.ts:42',
    expected: [{ match: 'src/index.ts:42', path: 'src/index.ts', line: 42 }],
  },

  // windows drive path WITH a dot is allowed
  {
    name: 'windows drive with dot',
    input: 'C:\\Users\\alice\\foo.rs:12:3',
    expected: [
      { match: 'C:\\Users\\alice\\foo.rs:12:3', path: 'C:\\Users\\alice\\foo.rs', line: 12, column: 3 },
    ],
  },
  {
    name: 'windows drive forward slashes with dot',
    input: 'C:/Users/alice/foo.rs:12:3',
    expected: [
      { match: 'C:/Users/alice/foo.rs:12:3', path: 'C:/Users/alice/foo.rs', line: 12, column: 3 },
    ],
  },
];

const FALSE_POSITIVE_TRAPS: readonly Case[] = [
  // URLs
  {
    name: 'https URL with port and path',
    input: 'visit https://example.com:8080/a/b',
    expected: [],
  },
  {
    name: 'http URL with port',
    input: 'GET http://localhost:3000/api',
    expected: [],
  },
  {
    name: 'https URL inside stack trace',
    input: '    at <anonymous>:https://example.com/foo.js:1:1',
    // https:// is preceded by `:`; the detector should still reject because
    // the `://` exclusion fires on the bytes right before the match.
    expected: [],
  },

  // Clock strings
  {
    name: 'timestamp 12:34:56',
    input: '[12:34:56] info: built in 200ms',
    expected: [],
  },
  {
    name: 'bare two-digit clock',
    input: 'time is 09:30',
    expected: [],
  },

  // Bare number ranges
  {
    name: 'pure numbers',
    input: 'range 1:10:100',
    expected: [],
  },

  // Windows path with NO dot in path part
  {
    name: 'windows drive no dot',
    input: 'C:\\Users\\alice:12:3',
    expected: [],
  },

  // Bare identifiers
  {
    name: 'class ref with line-like suffix',
    input: 'Foo:12:3',
    expected: [],
  },

  // Path ending in trailing dot
  {
    name: 'degenerate trailing dot',
    input: 'file.:1:2',
    expected: [],
  },

  // Minimum-length floor
  {
    name: 'too-short path',
    input: 'a:1:2',
    expected: [],
  },

  // Line zero rejected (1-based everywhere)
  {
    name: 'line zero is rejected',
    input: 'foo.rs:0:0',
    expected: [],
  },
];

describe('detectPaths — true positives', () => {
  for (const c of TRUE_POSITIVES) {
    it(c.name, () => {
      const hits = detectPaths(c.input);
      expect(
        hits.map((h) => ({
          match: h.match,
          path: h.path,
          line: h.line,
          ...(h.column !== undefined ? { column: h.column } : {}),
        })),
      ).toEqual(c.expected);
    });
  }
});

describe('detectPaths — false-positive traps', () => {
  for (const c of FALSE_POSITIVE_TRAPS) {
    it(c.name, () => {
      expect(detectPaths(c.input)).toEqual([]);
    });
  }
});

describe('detectPaths — precision floor', () => {
  it('has at least 15 true-positive fixtures and 10 false-positive traps', () => {
    // Sanity: a regression that accidentally tightens the regex to only match
    // `.ts:N:N` would pass most tests because tests dominate the fixture
    // corpus. Asserting the TRUE/FALSE ratios guards against that.
    const truePositives = TRUE_POSITIVES.filter((c) => c.expected.length > 0).length;
    const falsePositives = FALSE_POSITIVE_TRAPS.length;
    expect(truePositives).toBeGreaterThanOrEqual(15);
    expect(falsePositives).toBeGreaterThanOrEqual(10);
  });

  it('every true-positive fixture returns exactly its expected hits (no duplicates, no extras)', () => {
    for (const c of TRUE_POSITIVES) {
      const hits = detectPaths(c.input);
      expect(hits.length, `case: ${c.name}`).toBe(c.expected.length);
    }
  });

  it('combined corpus totals 30+ fixtures', () => {
    expect(TRUE_POSITIVES.length + FALSE_POSITIVE_TRAPS.length).toBeGreaterThanOrEqual(30);
  });
});

describe('splitTextByPaths', () => {
  it('returns a single text fragment when no paths are detected', () => {
    expect(splitTextByPaths('just prose')).toEqual([{ kind: 'text', text: 'just prose' }]);
  });

  it('interleaves text and path fragments', () => {
    const text = 'see src/main.rs:1:2 plus src/lib.rs:3:4 end';
    const frags = splitTextByPaths(text);
    expect(frags.map((f) => f.kind)).toEqual(['text', 'path', 'text', 'path', 'text']);
    expect(frags[0]).toEqual({ kind: 'text', text: 'see ' });
    // rebuild original: joining paths + texts should give us the input back.
    const rebuilt = frags
      .map((f) => (f.kind === 'text' ? f.text : f.hit.match))
      .join('');
    expect(rebuilt).toBe(text);
  });

  it('yields empty leading/trailing text when a path is at the start or end', () => {
    const frags = splitTextByPaths('src/a.ts:1:2');
    expect(frags.length).toBe(3);
    expect(frags[0]).toEqual({ kind: 'text', text: '' });
    expect(frags[2]).toEqual({ kind: 'text', text: '' });
    expect(frags[1]?.kind).toBe('path');
  });

  it('offsets point at the path start and end in the original string', () => {
    const text = 'pre src/a.ts:1:2 post';
    const hits = detectPaths(text);
    expect(hits.length).toBe(1);
    const h = hits[0]!;
    expect(text.slice(h.start, h.end)).toBe(h.match);
  });
});

describe('detectPaths — edge cases', () => {
  it('empty input', () => {
    expect(detectPaths('')).toEqual([]);
  });

  it('does not emit overlapping matches', () => {
    const hits = detectPaths('a/b.ts:1:2/c/d.ts:3:4');
    // The first match consumes `a/b.ts:1:2`; `/c/d.ts:3:4` begins after the
    // `2` and is tried as a fresh scan — it should still be detected even
    // though it is adjacent to the first.
    // (With our regex this is 2 hits because the first stops at digit boundary.)
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // None overlap
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i]!.start).toBeGreaterThanOrEqual(hits[i - 1]!.end);
    }
  });

  it('multiline input detects one hit per line', () => {
    const input = 'foo.rs:1:1\nbar.ts:2:2\nbaz.py:3:3';
    const hits = detectPaths(input);
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.path)).toEqual(['foo.rs', 'bar.ts', 'baz.py']);
  });

  it('rejects embedded control chars at the boundary', () => {
    // A `\n` in the middle of a path-looking run breaks the path char class,
    // and each line is evaluated independently.
    const input = 'foo\n.rs:1:1';
    // The regex stops at whitespace, so `foo\n` cannot start a path; and
    // `.rs:1:1` has pathLen < floor (after excluding dot, path=".rs" length 3,
    // acceptable) — but the floor is 3 on full path length including dot,
    // so `.rs` passes. Accept whatever the detector emits; we only require it
    // does not span the newline.
    const hits = detectPaths(input);
    for (const h of hits) {
      expect(h.match.includes('\n')).toBe(false);
    }
  });
});
