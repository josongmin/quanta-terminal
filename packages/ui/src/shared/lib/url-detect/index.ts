/**
 * URL detector — scan a block of plain text and return every clickable URL
 * reference inside it.
 *
 * This is the sibling of `shared/lib/path-detect`: path-detect finds
 * `file:line:col` patterns; url-detect finds bare HTTP/HTTPS/FTP/SSH/file/
 * mailto URLs plus SCP-style `user@host:path` and bare-domain references
 * (`example.com/page`).
 *
 * Out of scope for this module:
 *   - OSC 8 hyperlinks. Those are explicit terminal escape sequences and are
 *     already carried through as `AnsiSpan.link`. The renderer gives OSC 8
 *     precedence and suppresses this module's auto-linkification on any
 *     span that already carries a link (see AnsiOutput.tsx).
 *   - URL preview / open-graph fetching.
 *   - Unicode URLs (IDN / punycode). We deliberately restrict to an ASCII
 *     slug class — terminal output is overwhelmingly ASCII, and trying to
 *     decide which Unicode characters belong to a URL is an ambiguity
 *     sinkhole.
 *
 * Detection strategy:
 *   - Three independent regex passes over the input (scheme-prefixed URLs,
 *     SCP/mailto-style `user@host`, bare-domain `example.com/path`). We then
 *     sort + dedupe by start offset so higher-precedence hits win.
 *   - Schemes we accept: http, https, ftp, ssh, file, mailto.
 *   - Domain-only matches require:
 *       * preceded by whitespace / start of string / one of `([<"'`
 *       * a TLD drawn from a small allowlist so we don't linkify
 *         Python/JS module paths (`docker.io.nestedmodule`, `abc.js`).
 *       * followed by `/` or end-of-token — bare `example.com` with no path
 *         still matches, but `example.com.foo` (third dotted label) does NOT
 *         because the "TLD" is then not at the label boundary.
 *   - Trailing punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `)`, `]`, `'`, `"`,
 *     `>`) is stripped from the URL — matching the "URL at end of sentence"
 *     convention.
 *   - Balanced parens are preserved inside the URL — a trailing `)` is only
 *     stripped when the URL does not contain a matching `(`. This keeps
 *     Wikipedia-style URLs like `https://en.wikipedia.org/wiki/Foo_(bar)`
 *     intact while still closing `(https://example.com)` correctly.
 */

/** What kind of reference was detected. Callers can branch on this to pick
 *  an action (e.g. `ssh` is typically opened in a terminal, not a browser). */
export type UrlKind = 'http' | 'ssh' | 'domain' | 'mailto' | 'file' | 'ftp';

export interface DetectedUrl {
  /** Byte offset into the input where the match starts. */
  readonly start: number;
  /** Byte offset into the input where the match ends (exclusive). */
  readonly end: number;
  /** The canonical URL string (trailing punctuation already stripped). For
   *  `user@host:path` the value is returned verbatim — callers decide how to
   *  hand it off (typically `ssh://user@host/path` when opening).  */
  readonly url: string;
  readonly kind: UrlKind;
}

/**
 * TLD allowlist for bare-domain detection. Deliberately small — broader TLD
 * coverage would turn every `foo.info` / `foo.app` / `foo.py` into a false
 * positive. The set below covers the common cases users paste into a
 * terminal and skips single-letter / programming-language-filename TLDs.
 */
const DOMAIN_TLDS = new Set<string>([
  'com', 'org', 'net', 'io', 'dev', 'ai', 'co',
]);

/** Schemes accepted for the prefixed URL regex. */
const SCHEMES = ['https', 'http', 'ftp', 'ssh', 'file', 'mailto'] as const;
type Scheme = (typeof SCHEMES)[number];

/**
 * Scheme-prefixed URL. The body of the URL is any run of non-whitespace,
 * non-control, non-quote characters; we strip trailing punctuation after
 * the match. `mailto:` uses an `@`-bearing body so it happily matches a
 * trailing address without the `//` separator.
 */
const SCHEME_URL_RE = /\b(https?|ftp|ssh|file|mailto):(?:\/\/)?[^\s<>"'`\x00-\x1f\x7f]+/gi;

/**
 * SCP-style `user@host:path`. Accepts the classic `git@github.com:org/repo.git`
 * shape plus bare `user@host:path`. We deliberately accept only ONE `@`
 * (rejects base64-ish `abc@def@ghi` noise) and require a `:` with a
 * non-empty path after it. TLD presence is NOT required — users routinely
 * SSH into intranet hosts with no TLD.
 */
const SCP_URL_RE = /(?<![A-Za-z0-9._+-])([A-Za-z0-9._+-]+)@([A-Za-z0-9.-]+):([^\s<>"'`\x00-\x1f\x7f:@]+)/g;

/**
 * Bare-domain with optional path. Requires whitespace / line-start / a small
 * set of punctuation in front (so `docker.io.module` from a Python traceback
 * does NOT match). Each label is at most 63 chars (per RFC 1035), the TLD is
 * the final label before any `/` or EOL, and we allow an optional path.
 */
const BARE_DOMAIN_RE =
  /(?<=^|[\s([<"'`])([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(\/[^\s<>"'`\x00-\x1f\x7f]*)?/g;

/** Characters stripped from the end of a detected URL match. */
const TRAILING_PUNCT = new Set<string>([
  '.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '>', '`',
]);

/**
 * Pop trailing punctuation from `url`, returning the trimmed string. Balanced
 * brackets are honoured: a trailing `)` is kept when the URL contains a
 * matching `(` (and likewise for `]`).
 */
function trimTrailingPunct(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (!TRAILING_PUNCT.has(ch)) break;
    if (ch === ')' && countChar(url, '(', end) > countChar(url, ')', end - 1)) break;
    if (ch === ']' && countChar(url, '[', end) > countChar(url, ']', end - 1)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

function countChar(s: string, ch: string, upto: number): number {
  let n = 0;
  const limit = Math.min(upto, s.length);
  for (let i = 0; i < limit; i += 1) {
    if (s[i] === ch) n += 1;
  }
  return n;
}

function classifyScheme(s: string): UrlKind {
  const lower = s.toLowerCase() as Scheme;
  switch (lower) {
    case 'http':
    case 'https':
      return 'http';
    case 'ftp':
      return 'ftp';
    case 'ssh':
      return 'ssh';
    case 'file':
      return 'file';
    case 'mailto':
      return 'mailto';
  }
}

/**
 * Tail of a bare-domain candidate: walk labels, return the final label that
 * sits immediately before a `/` or end-of-host. That's the label we check
 * against the TLD allowlist.
 */
function tldOf(host: string): string {
  const dot = host.lastIndexOf('.');
  if (dot < 0 || dot === host.length - 1) return '';
  return host.slice(dot + 1).toLowerCase();
}

/**
 * Reject candidate that looks like an IPv4-ish dotted-number run
 * (`1.2.3.4.5`) — no letters anywhere.
 */
function isAllNumeric(host: string): boolean {
  for (let i = 0; i < host.length; i += 1) {
    const ch = host.charCodeAt(i);
    if (ch === 0x2e) continue; // '.'
    if (ch < 0x30 || ch > 0x39) return false;
  }
  return true;
}

/** Detect every URL-ish reference inside `text`. */
export function detectUrls(text: string): DetectedUrl[] {
  if (text.length === 0) return [];
  const out: DetectedUrl[] = [];

  // Pass 1: scheme-prefixed URLs.
  {
    const re = new RegExp(SCHEME_URL_RE.source, SCHEME_URL_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const scheme = m[1]!;
      const trimmed = trimTrailingPunct(raw);
      if (trimmed.length <= scheme.length + 1) continue;
      const start = m.index;
      const end = start + trimmed.length;
      out.push({ start, end, url: trimmed, kind: classifyScheme(scheme) });
    }
  }

  // Pass 2: SCP-style `user@host:path`.
  {
    const re = new RegExp(SCP_URL_RE.source, SCP_URL_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip if the user@ portion overlaps a prior scheme match (e.g.
      // `mailto:a@b.com` — the scheme pass already owns the range).
      const start = m.index;
      if (overlapsExisting(out, start)) continue;
      const full = m[0];
      const trimmed = trimTrailingPunct(full);
      if (trimmed === full.slice(0, trimmed.length) && trimmed.length < full.length) {
        // trimming happened; ok
      }
      // Require at least one char after the colon (non-empty path) — the regex
      // guarantees this but we re-check after trim.
      const colon = trimmed.lastIndexOf(':');
      if (colon < 0 || colon === trimmed.length - 1) continue;
      out.push({
        start,
        end: start + trimmed.length,
        url: trimmed,
        kind: 'ssh',
      });
    }
  }

  // Pass 3: bare domains.
  {
    const re = new RegExp(BARE_DOMAIN_RE.source, BARE_DOMAIN_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      if (overlapsExisting(out, start)) continue;
      const host = m[1]!;
      const path = m[2] ?? '';
      const raw = host + path;
      const trimmed = trimTrailingPunct(raw);
      // Domain-only guards:
      //   - host must contain at least one letter (reject `1.2.3.4` runs).
      if (isAllNumeric(host)) continue;
      //   - TLD must be in our allowlist.
      const tld = tldOf(host);
      if (!DOMAIN_TLDS.has(tld)) continue;
      //   - Reject the "more dotted labels follow" case: after the URL match
      //     ends, if the next character is `.` followed by an identifier-like
      //     char, this was probably a Python/JS dotted path rather than a
      //     domain. We already prevent the regex from consuming into that
      //     next dot because of the anchored host tail, but a trailing `.foo`
      //     in the input stream still suggests the host is part of a longer
      //     token.
      const nextIdx = start + trimmed.length;
      if (nextIdx < text.length) {
        const nextCh = text[nextIdx]!;
        // If the next char continues an identifier ('.' only matters when
        // the path is empty — with a path present the domain is clearly a
        // URL), flag it and skip.
        if (path.length === 0 && nextCh === '.') continue;
      }
      //   - Reject bare domains preceded by identifier characters even when
      //     our lookbehind matched a permissive boundary. The lookbehind
      //     already covers start-of-string / whitespace / opener chars, but
      //     we double-check for the identifier case (defense in depth for
      //     engines that treat `\b` oddly around Unicode input).
      if (start > 0) {
        const prev = text[start - 1]!;
        if (/[A-Za-z0-9_]/.test(prev)) continue;
      }
      out.push({
        start,
        end: start + trimmed.length,
        url: trimmed,
        kind: 'domain',
      });
    }
  }

  // Sort by start, then (stable-ish) by length descending so longer matches
  // win overlapping territory.
  out.sort((a, b) => (a.start - b.start) || (b.end - b.start) - (a.end - a.start));
  // Dedup: drop any entry whose range overlaps the preceding entry.
  const deduped: DetectedUrl[] = [];
  for (const hit of out) {
    const last = deduped[deduped.length - 1];
    if (last && hit.start < last.end) continue;
    deduped.push(hit);
  }
  return deduped;
}

function overlapsExisting(list: readonly DetectedUrl[], start: number): boolean {
  for (const h of list) {
    if (start >= h.start && start < h.end) return true;
  }
  return false;
}

/** Split `text` into alternating plain-text / url fragments, for renderers
 *  that need to interleave `<span>` and `<a>` children. Mirrors the shape of
 *  `splitTextByPaths` in `shared/lib/path-detect`. */
export type UrlFragment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'url'; readonly hit: DetectedUrl };

export function splitTextByUrls(text: string): UrlFragment[] {
  const hits = detectUrls(text);
  if (hits.length === 0) return [{ kind: 'text', text }];
  const out: UrlFragment[] = [];
  let cursor = 0;
  for (const h of hits) {
    out.push({ kind: 'text', text: text.slice(cursor, h.start) });
    out.push({ kind: 'url', hit: h });
    cursor = h.end;
  }
  out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}
