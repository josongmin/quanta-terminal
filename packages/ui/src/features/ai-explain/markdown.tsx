/**
 * `renderSimpleMarkdown` — tiny regex-based formatter used by the
 * AiExplainPanel to render the provider's returned paragraph inline.
 *
 * Not a full Markdown parser (scope rule: no new deps). Supports:
 *   - Fenced code: ``` … ``` — rendered as a `<pre><code>` block. The
 *     fence may optionally carry a language tag (discarded in this pass).
 *   - Inline code: `…` — rendered as `<code>`.
 *   - Bold: **…** — rendered as `<strong>`.
 *   - Italic: *…* — rendered as `<em>`.
 *   - Paragraph breaks (blank lines) and single newlines (`<br />`).
 *
 * The function returns a tree of `ReactNode` elements rather than an HTML
 * string so we never round-trip through `dangerouslySetInnerHTML` — the AI
 * provider's output is untrusted and we want every piece of content to flow
 * through React's text-escaping.
 *
 * Precedence matches the conventional markdown parse order:
 *
 *   1. fenced code (greedy block, swallows everything between ``` fences)
 *   2. inline code (single-backtick runs within a paragraph)
 *   3. bold (**x**) before italic (*x*) so `**x**` isn't mis-parsed as
 *      two italics
 *
 * All regexes run on string slices, and we never use the `s` flag so a
 * runaway backtick in one paragraph cannot swallow the next. Pathological
 * inputs fall through as plain text rather than hanging.
 */

import { Fragment, type ReactNode } from 'react';

/**
 * Split the input on fenced code blocks. Each entry is either a string
 * (prose) or an object tagged with a code payload. Exported for tests.
 */
export interface ProseSegment {
  readonly kind: 'prose';
  readonly text: string;
}
export interface CodeSegment {
  readonly kind: 'code';
  readonly text: string;
}
export type MarkdownSegment = ProseSegment | CodeSegment;

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;

export function splitFencedSegments(source: string): readonly MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  let lastIndex = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      out.push({ kind: 'prose', text: source.slice(lastIndex, match.index) });
    }
    out.push({ kind: 'code', text: match[1] ?? '' });
    lastIndex = FENCE_RE.lastIndex;
  }
  if (lastIndex < source.length) {
    out.push({ kind: 'prose', text: source.slice(lastIndex) });
  }
  return out;
}

/**
 * Render a prose fragment: split on blank lines into paragraphs, then apply
 * inline formatters (code, bold, italic) within each paragraph. Single
 * newlines become `<br />`.
 */
function renderProse(text: string, keyPrefix: string): ReactNode {
  const trimmed = text.replace(/^\n+|\n+$/g, '');
  if (trimmed.length === 0) return null;
  const paragraphs = trimmed.split(/\n{2,}/g);
  return paragraphs.map((p, i) => {
    const lines = p.split('\n');
    const children: ReactNode[] = [];
    lines.forEach((line, lineIdx) => {
      if (lineIdx > 0) children.push(<br key={`br-${keyPrefix}-${i}-${lineIdx}`} />);
      children.push(
        <Fragment key={`line-${keyPrefix}-${i}-${lineIdx}`}>
          {renderInline(line, `${keyPrefix}-${i}-${lineIdx}`)}
        </Fragment>,
      );
    });
    return (
      <p key={`${keyPrefix}-p-${i}`}>
        {children}
      </p>
    );
  });
}

/**
 * Inline formatter — runs in a stable order (code → bold → italic) and emits
 * a flat ReactNode array. Tokens are non-overlapping by construction: the
 * function consumes each token when matched and re-recurses on the REMAINING
 * unformatted text only, which prevents double-coverage (e.g. a literal
 * `*` inside backticks must render as `*`).
 */
export function renderInline(text: string, keyPrefix: string): ReactNode {
  if (text.length === 0) return null;
  // Priority pattern list. Order matters: inline-code steals first so its
  // contents are never interpreted as bold/italic; bold beats italic so that
  // `**x**` doesn't get eaten as two adjacent italics.
  const patterns: ReadonlyArray<{
    readonly re: RegExp;
    readonly render: (match: RegExpExecArray, key: string) => ReactNode;
  }> = [
    {
      re: /`([^`]+)`/,
      render: (m, key) => <code key={key}>{m[1]}</code>,
    },
    {
      re: /\*\*([^*]+)\*\*/,
      render: (m, key) => <strong key={key}>{m[1]}</strong>,
    },
    {
      re: /\*([^*]+)\*/,
      render: (m, key) => <em key={key}>{m[1]}</em>,
    },
  ];

  // Find the earliest match across all patterns.
  let earliest: { start: number; end: number; node: ReactNode } | null = null;
  for (let i = 0; i < patterns.length; i += 1) {
    const p = patterns[i]!;
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (m === null) continue;
    if (earliest === null || m.index < earliest.start) {
      earliest = {
        start: m.index,
        end: m.index + m[0].length,
        node: p.render(m, `${keyPrefix}-${i}-${m.index}`),
      };
    }
  }
  if (earliest === null) return text;
  const nodes: ReactNode[] = [];
  if (earliest.start > 0) {
    nodes.push(
      <Fragment key={`${keyPrefix}-pre`}>
        {text.slice(0, earliest.start)}
      </Fragment>,
    );
  }
  nodes.push(earliest.node);
  const rest = text.slice(earliest.end);
  if (rest.length > 0) {
    nodes.push(
      <Fragment key={`${keyPrefix}-rest`}>
        {renderInline(rest, `${keyPrefix}-r`)}
      </Fragment>,
    );
  }
  return <Fragment key={`${keyPrefix}-frag`}>{nodes}</Fragment>;
}

export function renderSimpleMarkdown(source: string): ReactNode {
  if (source.length === 0) return null;
  const segments = splitFencedSegments(source);
  return segments.map((seg, i) => {
    if (seg.kind === 'code') {
      return (
        <pre key={`seg-${i}`}>
          <code>{seg.text}</code>
        </pre>
      );
    }
    return <Fragment key={`seg-${i}`}>{renderProse(seg.text, `s${i}`)}</Fragment>;
  });
}
