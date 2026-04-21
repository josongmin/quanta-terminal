/**
 * url-detect — precision tests for auto-linkification of plain-text URLs in
 * terminal output. Fixtures span:
 *   - Scheme-prefixed URLs (http/https/ftp/ssh/file/mailto).
 *   - SCP-style git remotes (`git@github.com:org/repo.git`).
 *   - Bare domains like `example.com/page` when preceded by whitespace.
 *
 * False-positive traps we deliberately REJECT:
 *   - Python-ish module paths (`docker.io.nestedmodule`, `abc.js`).
 *   - IPv4-ish runs that would otherwise look like host.label (`1.2.3.4.5`).
 *   - `hello.world` where the TLD is not in the allowlist.
 *   - Bare domain in the middle of an identifier (`xexample.com`).
 *
 * Edge cases covered:
 *   - Parenthesised URL: `(https://example.com)` → closing paren stripped.
 *   - Wikipedia-style balanced parens preserved inside the URL.
 *   - Trailing sentence punctuation stripped (`.`, `,`, `?`, `!`).
 *   - Multiple URLs on one line.
 *   - URL at end of line, URL in the middle of text.
 *   - Multi-line input.
 */

import { describe, expect, it } from 'vitest';
import { detectUrls, splitTextByUrls, type DetectedUrl } from '../index.js';

type Case = {
  readonly name: string;
  readonly input: string;
  readonly expected: ReadonlyArray<{ readonly url: string; readonly kind: DetectedUrl['kind'] }>;
};

const TRUE_POSITIVES: readonly Case[] = [
  {
    name: 'bare https',
    input: 'see https://example.com for details',
    expected: [{ url: 'https://example.com', kind: 'http' }],
  },
  {
    name: 'http with path and query and fragment',
    input: 'visit http://a.b.c/path?q=1#frag now',
    expected: [{ url: 'http://a.b.c/path?q=1#frag', kind: 'http' }],
  },
  {
    name: 'ftp',
    input: 'download from ftp://ftp.kernel.org/ soon',
    expected: [{ url: 'ftp://ftp.kernel.org/', kind: 'ftp' }],
  },
  {
    name: 'ssh scheme',
    input: 'clone ssh://git@example.com/repo.git please',
    expected: [{ url: 'ssh://git@example.com/repo.git', kind: 'ssh' }],
  },
  {
    name: 'file scheme',
    input: 'open file:///etc/hosts in vi',
    expected: [{ url: 'file:///etc/hosts', kind: 'file' }],
  },
  {
    name: 'mailto',
    input: 'email mailto:a@b.com if you can',
    expected: [{ url: 'mailto:a@b.com', kind: 'mailto' }],
  },
  {
    name: 'git scp-style',
    input: 'clone git@github.com:user/repo.git next',
    expected: [{ url: 'git@github.com:user/repo.git', kind: 'ssh' }],
  },
  {
    name: 'user@host:path scp',
    input: 'scp me@host:backup/data.tar away',
    expected: [{ url: 'me@host:backup/data.tar', kind: 'ssh' }],
  },
  {
    name: 'bare domain with path after space',
    input: 'try example.com/page for info',
    expected: [{ url: 'example.com/page', kind: 'domain' }],
  },
  {
    name: 'bare domain after line start',
    input: 'example.com/path is up',
    expected: [{ url: 'example.com/path', kind: 'domain' }],
  },
  {
    name: 'multiple urls on one line',
    input: 'see https://a.com and http://b.com now',
    expected: [
      { url: 'https://a.com', kind: 'http' },
      { url: 'http://b.com', kind: 'http' },
    ],
  },
  {
    name: 'url at end of line',
    input: 'final link: https://end-of-line.example.com',
    expected: [{ url: 'https://end-of-line.example.com', kind: 'http' }],
  },
  {
    name: 'multi-line input',
    input: 'line one https://first.example.com\nline two https://second.example.com',
    expected: [
      { url: 'https://first.example.com', kind: 'http' },
      { url: 'https://second.example.com', kind: 'http' },
    ],
  },
];

describe('url-detect — true positives', () => {
  for (const c of TRUE_POSITIVES) {
    it(c.name, () => {
      const got = detectUrls(c.input).map((h) => ({ url: h.url, kind: h.kind }));
      expect(got).toEqual(c.expected);
    });
  }
});

describe('url-detect — trailing punctuation', () => {
  it('strips trailing period', () => {
    const got = detectUrls('See https://example.com.');
    expect(got).toHaveLength(1);
    expect(got[0]?.url).toBe('https://example.com');
  });

  it('strips trailing comma', () => {
    const got = detectUrls('visit https://example.com, then go');
    expect(got[0]?.url).toBe('https://example.com');
  });

  it('strips closing paren for parenthesised URL', () => {
    const got = detectUrls('(https://example.com)');
    expect(got).toHaveLength(1);
    expect(got[0]?.url).toBe('https://example.com');
  });

  it('keeps balanced parens inside the URL', () => {
    const got = detectUrls('see https://en.wikipedia.org/wiki/Foo_(bar) now');
    expect(got[0]?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('strips closing bracket', () => {
    const got = detectUrls('[https://example.com]');
    expect(got[0]?.url).toBe('https://example.com');
  });

  it('strips trailing question mark and exclamation', () => {
    const got1 = detectUrls('did you see https://example.com?');
    expect(got1[0]?.url).toBe('https://example.com');
    const got2 = detectUrls('wow https://example.com!');
    expect(got2[0]?.url).toBe('https://example.com');
  });
});

describe('url-detect — false positives rejected', () => {
  it('rejects Python-ish module path `docker.io.nestedmodule`', () => {
    // The `.io` TLD in our allowlist would otherwise flag docker.io; because
    // the text continues with another dotted identifier segment, we treat it
    // as a module path.
    const got = detectUrls('import docker.io.nestedmodule as d');
    expect(got).toEqual([]);
  });

  it('rejects TLD not in allowlist', () => {
    const got = detectUrls('open abc.js file and hello.world string');
    expect(got).toEqual([]);
  });

  it('rejects IPv4-ish dotted-number run', () => {
    const got = detectUrls('arr = 1.2.3.4.5');
    expect(got).toEqual([]);
  });

  it('rejects bare domain in the middle of an identifier', () => {
    const got = detectUrls('varxexample.comfoo');
    expect(got).toEqual([]);
  });

  it('rejects bare domain when prior char is an identifier continuation', () => {
    // Preceded by `/`: looks like a shell path segment, not a URL.
    const got = detectUrls('prefix/example.com/path');
    // The lookbehind does not match `/` so the domain candidate never starts
    // here; result is no hits.
    expect(got).toEqual([]);
  });

  it('does not linkify python import paths at label boundary', () => {
    // `urllib.parse.urlparse` — `.parse` isn't in the TLD allowlist so the
    // whole run is rejected.
    const got = detectUrls('from urllib.parse.urlparse import x');
    expect(got).toEqual([]);
  });
});

describe('splitTextByUrls', () => {
  it('returns a single text fragment when there are no URLs', () => {
    const frags = splitTextByUrls('no urls here');
    expect(frags).toEqual([{ kind: 'text', text: 'no urls here' }]);
  });

  it('interleaves text and url fragments', () => {
    const frags = splitTextByUrls('see https://a.com and https://b.com ok');
    expect(frags.filter((f) => f.kind === 'url')).toHaveLength(2);
    const textBits = frags.filter((f): f is { kind: 'text'; text: string } => f.kind === 'text');
    expect(textBits[0]?.text).toBe('see ');
    expect(textBits[textBits.length - 1]?.text).toBe(' ok');
  });
});
