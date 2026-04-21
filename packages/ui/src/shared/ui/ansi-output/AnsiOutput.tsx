/**
 * AnsiOutput — React renderer for `AnsiSpan[]` produced by `AnsiParser`.
 *
 * Design:
 *   - One `<pre>` container; each span is a `<span>` (or `<a>` if it carries
 *     an OSC 8 `link`). No nested structure — the parser guarantees a flat
 *     stream.
 *   - Named / bright colors map to CSS classes (theme-driven).
 *     Indexed / RGB colors use inline `style` with a resolved palette color.
 *   - The component is `React.memo`'d on the span array identity. Agent A's
 *     block store must return a STABLE reference across renders of unchanged
 *     blocks so we don't re-map the span array. (The parser already emits a
 *     fresh array only on new bytes.)
 *
 * Control-character handling:
 *   - Backspace marker (`\u0008`) inside span text:
 *       * default: render as zero-width (skip the byte).
 *       * `carriageReturnRewrites: true`: emulate visual backspace — last
 *         visible character is dropped from the rendered string.
 *   - Carriage return (`\r`) inside span text:
 *       * default: rendered as the literal character (harmless; `<pre>` shows
 *         nothing for a bare CR on most browsers but it does not corrupt
 *         layout).
 *       * `carriageReturnRewrites: true`: treat as "rewrite current line";
 *         drop everything emitted since the last LF in the OUTPUT buffer so
 *         progress bars display their latest frame.
 *
 * Out of scope (documented):
 *   - Width measurement (`maxWidth`) is a hint for future overflow handling;
 *     the current pre uses `white-space: pre-wrap` and wraps naturally.
 *   - Cursor movement, inverse-by-theme background: renderer applies `inverse`
 *     by swapping fg and bg styles; it does not implement the xterm
 *     "reverse video entire line" quirk.
 */

import { memo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { BACKSPACE_MARKER } from '../../lib/ansi-parser/index.js';
import { cx } from '../../lib/cx.js';
import { splitTextByPaths, type DetectedPath } from '../../lib/path-detect/index.js';
import { detectUrls, type DetectedUrl } from '../../lib/url-detect/index.js';
import styles from './ansi-output.module.css';
import { indexed256ToCss } from './palette.js';
import type { AnsiColor, AnsiSpan } from './types.js';

/** Payload delivered to `onPathClick` when the user activates a detected file link. */
export interface PathClickPayload {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
}

/**
 * Payload delivered to `onUrlClick` when the user activates a detected URL in
 * plain-text output. The kind flag lets callers branch — bare domains may be
 * treated differently from ssh/scp-style references, for example.
 */
export interface UrlClickPayload {
  readonly url: string;
  readonly kind: DetectedUrl['kind'];
}

/**
 * Input shape for the output-search highlight overlay. Each entry is scoped
 * to ONE span (by `spans[i]` index) and enumerates the sub-ranges (in span-
 * local rendered-text offsets) that should be wrapped in `<mark>`.
 *
 * The `activeSpanIndex`/`activeRangeIndex` pair optionally marks one of
 * those entries as the "current" match (the one Enter is navigating to);
 * that range gets an additional `.searchMarkActive` class so the user can
 * see which hit has focus among many.
 *
 * `features/output-search` builds this structure from the global match
 * list and passes it through BlockCard. AnsiOutput stays agnostic of the
 * match source so tests and Storybook can feed a hand-rolled highlight
 * layer.
 */
export interface SearchHighlights {
  /** One entry per span; missing entries (sparse array) = "no hits in this span". */
  readonly perSpan: ReadonlyArray<
    ReadonlyArray<{ readonly start: number; readonly length: number }>
  >;
  /** Index into `spans` identifying the span that holds the active hit, or null. */
  readonly activeSpanIndex?: number | null;
  /** Index into `perSpan[activeSpanIndex]` identifying the active range, or null. */
  readonly activeRangeIndex?: number | null;
}

export interface AnsiOutputProps {
  readonly spans: readonly AnsiSpan[];
  /**
   * Optional streaming version stamp. Streaming consumers push into a stable
   * `spans` array reference (to avoid O(n²) allocation) and bump `version`
   * instead of allocating a fresh array. Default React.memo picks this up via
   * shallow prop compare, so a version change alone triggers a re-render
   * without paying for array churn.
   */
  readonly version?: number;
  /** Width hint in ch-units. Reserved for future overflow handling; unused today. */
  readonly maxWidth?: number;
  /** Called when the user clicks an OSC 8 link. preventDefault is applied. */
  readonly onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Phase-3 error-to-code navigation. When set, the renderer scans each plain
   * span's text for `path:line[:col]` patterns and wraps them in a
   * `<button class="pathLink">` that invokes this callback. The button is
   * keyboard-accessible (Enter / Space activate it) and styled with an
   * underline + hover affordance so the target is discoverable.
   *
   * If omitted, the renderer stays in its Phase-2 behaviour: no scanning,
   * no buttons, zero extra DOM nodes per span.
   */
  readonly onPathClick?: (payload: PathClickPayload, event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Plain-text URL autolinkification. When set, the renderer scans each
   * non-OSC-8 span for bare URLs (`https://…`, `git@github.com:…`,
   * `example.com/path`) and wraps them in an `<a>` so the user can click to
   * open.
   *
   * OSC 8 precedence: spans that already carry `span.link` (terminal-emitted
   * hyperlinks) render as anchors before this callback is ever consulted, so
   * autolinkification never overlaps explicit terminal hyperlinks.
   *
   * Omit the prop to keep the Phase-2 behaviour (no scan, no anchors, zero
   * extra DOM nodes).
   */
  readonly onUrlClick?: (payload: UrlClickPayload, event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * If true, `\r` and `\x08` rewrite / erase visible text as a real terminal
   * would. Defaults to false because for most build output CR/BS are noise
   * left over from interactive shells. Progress-bar-heavy workloads (pnpm
   * install, wget) should pass `true`.
   */
  readonly carriageReturnRewrites?: boolean;
  /** Additional class on the <pre> wrapper (tests / block chrome integration). */
  readonly className?: string;
  /**
   * Output-search overlay. When present (and a span has non-empty ranges),
   * the renderer splits the span's rendered text at hit boundaries and
   * wraps matches in `<mark>`. Mutually composable with `onPathClick` —
   * path detection runs first, search highlighting runs over the resulting
   * text slices. The two features share a `<span>`; a path link inside a
   * search match still reads as a link, the `<mark>` background sits behind it.
   */
  readonly searchHighlights?: SearchHighlights;
}

interface RenderedSpan {
  readonly key: number;
  readonly text: string;
  readonly className: string;
  readonly style: CSSProperties;
  readonly link?: string;
}

function namedClass(kind: 'fg' | 'bg', name: 'named' | 'bright', index: number): string {
  // Keys are dynamic; we still index into the typed styles object so that a
  // typo in the CSS name surfaces as a missing class at runtime rather than
  // silently compiling.
  const key = `${kind}-${name}-${index}`;
  return (styles as Record<string, string | undefined>)[key] ?? '';
}

/**
 * Translate an `AnsiColor` to either a CSS class name OR an inline style
 * fragment. Named + bright use the class path (theme tokens); indexed + rgb
 * use inline style so arbitrary colors render without ballooning the class
 * surface.
 */
function colorToStyle(
  color: AnsiColor,
  kind: 'fg' | 'bg',
): { readonly className?: string; readonly style?: CSSProperties } {
  switch (color.kind) {
    case 'named':
      return { className: namedClass(kind, 'named', color.index) };
    case 'bright':
      return { className: namedClass(kind, 'bright', color.index) };
    case 'indexed': {
      const css = indexed256ToCss(color.index);
      return { style: kind === 'fg' ? { color: css } : { backgroundColor: css } };
    }
    case 'rgb': {
      const css = `rgb(${color.r}, ${color.g}, ${color.b})`;
      return { style: kind === 'fg' ? { color: css } : { backgroundColor: css } };
    }
    case 'default':
      // Inherit from <pre>.
      return {};
  }
}

/**
 * Apply control-character rewriting to the assembled visible text if the
 * caller opted in. When opted out, we just strip the backspace sentinels so
 * they don't render as a literal glyph (some browsers do, and it's ugly).
 *
 * Exported so features/output-search can project span text the same way the
 * renderer does — the two paths MUST agree on the final character offsets
 * or the search highlights would land on the wrong substrings.
 */
export function applyControlChars(text: string, rewrites: boolean): string {
  if (!rewrites) {
    // Default: strip BS sentinels; keep CR as-is (it's a no-op glyph in <pre>).
    return text.includes(BACKSPACE_MARKER) ? text.replaceAll(BACKSPACE_MARKER, '') : text;
  }
  // Rewrite mode: emulate line-discipline CR / BS in one pass. We walk
  // characters, tracking the start of the "current line" inside the out
  // buffer so `\r` can collapse back to it.
  let out = '';
  let lineStart = 0;
  for (const ch of text) {
    if (ch === '\n') {
      out += ch;
      lineStart = out.length;
      continue;
    }
    if (ch === '\r') {
      // Truncate back to the current line start.
      out = out.slice(0, lineStart);
      continue;
    }
    if (ch === BACKSPACE_MARKER) {
      // Drop the last character on the current line, if any.
      if (out.length > lineStart) {
        out = out.slice(0, -1);
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function renderSpan(span: AnsiSpan, key: number, rewrites: boolean): RenderedSpan {
  const classList: string[] = [];
  let style: CSSProperties = {};

  // Color resolution. `inverse` means we flip fg/bg at the style layer so the
  // color class names reflect the rendered intent; this is a best-effort
  // approximation of xterm's inverse behavior and works for nearly all cases
  // short of "inverse with no explicit fg/bg".
  const fg = span.inverse ? span.bg : span.fg;
  const bg = span.inverse ? span.fg : span.bg;

  if (fg !== undefined) {
    const { className, style: s } = colorToStyle(fg, 'fg');
    if (className) classList.push(className);
    if (s) style = { ...style, ...s };
  }
  if (bg !== undefined) {
    const { className, style: s } = colorToStyle(bg, 'bg');
    if (className) classList.push(className);
    if (s) style = { ...style, ...s };
  }
  if (span.inverse && fg === undefined && bg === undefined) {
    // Bare `\x1b[7m` with no colors set: invert fg ↔ bg at the CSS level.
    // Inline style so it wins over the default color inheritance.
    style = { ...style, color: 'var(--q-bg)', backgroundColor: 'var(--q-fg)' };
  }

  if (span.bold) classList.push(styles['bold']!);
  if (span.dim) classList.push(styles['dim']!);
  if (span.italic) classList.push(styles['italic']!);
  if (span.underline) classList.push(styles['underline']!);
  if (span.strike) classList.push(styles['strike']!);
  if (span.hidden) classList.push(styles['hidden']!);

  const text = applyControlChars(span.text, rewrites);

  const rendered: RenderedSpan = {
    key,
    text,
    className: classList.join(' '),
    style,
  };
  return span.link !== undefined ? { ...rendered, link: span.link } : rendered;
}

/**
 * Interleaved detection fragments — a plain text run, a `path:line:col` hit,
 * or a URL hit. We detect paths FIRST (Phase 3) and then run URL detection
 * only over the residual plain-text slices so that a `path:line:col` match
 * is not re-classified as a bare-domain URL. This mirrors real precedence:
 * `src/foo.ts:12:3` is a path, not a URL.
 */
type DetectFragment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'path'; readonly hit: DetectedPath }
  | { readonly kind: 'url'; readonly hit: DetectedUrl };

function detectFragments(text: string, wantUrls: boolean): DetectFragment[] {
  // First pass: splice by `path:line:col` hits.
  const pathSplit = splitTextByPaths(text);
  if (!wantUrls) {
    return pathSplit.map<DetectFragment>((f) =>
      f.kind === 'text' ? { kind: 'text', text: f.text } : { kind: 'path', hit: f.hit },
    );
  }
  // Second pass: re-scan each TEXT fragment for URLs and splice those in
  // too. Path hits are passed through verbatim so they keep precedence.
  const out: DetectFragment[] = [];
  for (const f of pathSplit) {
    if (f.kind !== 'text') {
      out.push({ kind: 'path', hit: f.hit });
      continue;
    }
    const urls = detectUrls(f.text);
    if (urls.length === 0) {
      out.push({ kind: 'text', text: f.text });
      continue;
    }
    let cursor = 0;
    for (const u of urls) {
      if (cursor < u.start) {
        out.push({ kind: 'text', text: f.text.slice(cursor, u.start) });
      }
      out.push({ kind: 'url', hit: u });
      cursor = u.end;
    }
    if (cursor < f.text.length) {
      out.push({ kind: 'text', text: f.text.slice(cursor) });
    }
  }
  return out;
}

/**
 * When path OR URL detection is enabled for a plain span, splice its text
 * into interleaved `<span>` / `<button>` / `<a>` nodes. The parent span
 * carries the SGR styling (class/style) so selection and copy-paste continue
 * to feel like raw terminal output.
 *
 * OSC 8 precedence is enforced at the call site: spans that already carry
 * `r.link` are rendered as anchors BEFORE this function is reached, so the
 * autolinker never overlays an explicit terminal hyperlink.
 */
function renderPlainSpanWithDetection(
  r: RenderedSpan,
  keyPrefix: number,
  onPathClick: AnsiOutputProps['onPathClick'] | undefined,
  onUrlClick: AnsiOutputProps['onUrlClick'] | undefined,
): ReactNode {
  const fragments = detectFragments(r.text, onUrlClick !== undefined);
  if (fragments.length === 1 && fragments[0]!.kind === 'text') {
    return (
      <span key={r.key} className={r.className} style={r.style}>
        {r.text}
      </span>
    );
  }
  const children: ReactNode[] = [];
  let i = 0;
  for (const f of fragments) {
    if (f.kind === 'text') {
      if (f.text.length > 0) {
        children.push(<span key={`${keyPrefix}-t${i}`}>{f.text}</span>);
      }
    } else if (f.kind === 'path') {
      if (onPathClick !== undefined) {
        children.push(renderPathButton(f.hit, `${keyPrefix}-p${i}`, onPathClick));
      } else {
        // Path detection passed us a hit but the caller didn't wire a click
        // handler — render the matched text as plain inline content.
        children.push(<span key={`${keyPrefix}-p${i}`}>{f.hit.match}</span>);
      }
    } else {
      if (onUrlClick !== undefined) {
        children.push(renderUrlAnchor(f.hit, `${keyPrefix}-u${i}`, onUrlClick));
      } else {
        children.push(<span key={`${keyPrefix}-u${i}`}>{f.hit.url}</span>);
      }
    }
    i += 1;
  }
  return (
    <span key={r.key} className={r.className} style={r.style}>
      {children}
    </span>
  );
}

function renderUrlAnchor(
  hit: DetectedUrl,
  key: string,
  onUrlClick: NonNullable<AnsiOutputProps['onUrlClick']>,
): ReactNode {
  // We render an <a> (not a <button>) so the URL is visible in the element
  // inspector and screen readers announce it as a link. `href` is the
  // canonical URL — some browsers / OS handlers require a fully qualified
  // scheme, so bare-domain hits (`example.com/page`) get a leading
  // `https://`. The click handler calls `preventDefault` before delegating
  // so the browser never auto-navigates without the confirmation flow.
  const href = inferHref(hit);
  return (
    <a
      key={key}
      href={href}
      className={styles['urlLink']}
      data-url-link="true"
      data-url={hit.url}
      data-url-kind={hit.kind}
      rel="noreferrer noopener"
      target="_blank"
      title={`Open ${hit.url}`}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onUrlClick({ url: hit.url, kind: hit.kind }, event);
      }}
    >
      {hit.url}
    </a>
  );
}

function inferHref(hit: DetectedUrl): string {
  if (hit.kind === 'domain') return `https://${hit.url}`;
  if (hit.kind === 'ssh' && !/^ssh:/i.test(hit.url)) {
    // `git@github.com:org/repo.git` → give the anchor a valid `ssh://` href
    // so standard-compliant browsers treat it as a link target rather than
    // a freeform string. The actual open flow uses `canonicaliseForOpen`
    // which does the same substitution.
    const at = hit.url.indexOf('@');
    if (at > 0) {
      const colon = hit.url.indexOf(':', at + 1);
      if (colon > at) {
        return `ssh://${hit.url.slice(0, colon)}/${hit.url.slice(colon + 1)}`;
      }
    }
  }
  return hit.url;
}

function renderPathButton(
  hit: DetectedPath,
  key: string,
  onPathClick: NonNullable<AnsiOutputProps['onPathClick']>,
): ReactNode {
  // A <button> (not <a>) because the target is not a URL; using an anchor
  // without a real href would harm accessibility tooling. The button inherits
  // the surrounding color so it visually reads like styled terminal text.
  return (
    <button
      key={key}
      type="button"
      className={styles['pathLink']}
      data-path-link="true"
      data-path={hit.path}
      data-line={String(hit.line)}
      {...(hit.column !== undefined ? { 'data-column': String(hit.column) } : {})}
      title={`Open ${hit.match} in your editor`}
      onClick={(event) => {
        // The header in BlockCard is itself a button-role element that
        // toggles collapse on click — without stopPropagation every
        // open-in-editor click would also collapse the card.
        event.stopPropagation();
        event.preventDefault();
        const payload: PathClickPayload =
          hit.column !== undefined
            ? { path: hit.path, line: hit.line, column: hit.column }
            : { path: hit.path, line: hit.line };
        onPathClick(payload, event);
      }}
    >
      {hit.match}
    </button>
  );
}

/**
 * Split a span's text into interleaved plain / <mark> children by the given
 * search ranges. Ranges are local to the span, sorted ascending and non-
 * overlapping (the caller — features/output-search/highlight — guarantees
 * this). When `activeRangeIndex` matches, the corresponding <mark> also
 * carries `.searchMarkActive` so the navigation cursor is visible.
 */
function renderSearchHighlightedText(
  text: string,
  ranges: ReadonlyArray<{ readonly start: number; readonly length: number }>,
  activeRangeIndex: number | null,
  keyPrefix: string | number,
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(start, Math.min(text.length, r.start + r.length));
    if (end <= start) continue;
    if (cursor < start) {
      out.push(<span key={`${keyPrefix}-pre${i}`}>{text.slice(cursor, start)}</span>);
    }
    const markClass = cx(
      styles['searchMark'],
      i === activeRangeIndex ? styles['searchMarkActive'] : undefined,
    );
    out.push(
      <mark
        key={`${keyPrefix}-hit${i}`}
        className={markClass}
        data-testid={i === activeRangeIndex ? 'search-mark-active' : 'search-mark'}
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    out.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
  }
  return out;
}

function AnsiOutputImpl(props: AnsiOutputProps) {
  const {
    spans,
    onLinkClick,
    onPathClick,
    onUrlClick,
    carriageReturnRewrites = false,
    className,
    maxWidth,
    searchHighlights,
  } = props;

  const wrapperStyle: CSSProperties | undefined =
    maxWidth !== undefined ? { maxWidth: `${maxWidth}ch` } : undefined;

  const perSpanHits = searchHighlights?.perSpan ?? null;
  const activeSpanIndex = searchHighlights?.activeSpanIndex ?? null;
  const activeRangeIndex = searchHighlights?.activeRangeIndex ?? null;

  // Render spans. We intentionally DO NOT merge or collapse adjacent spans;
  // the parser already gives us the coarsest granularity it can, and merging
  // here would complicate the link-insertion code for minimal DOM win.
  const children = spans.map((span, i) => {
    const r = renderSpan(span, i, carriageReturnRewrites);
    if (r.text.length === 0) return null;
    if (r.link !== undefined) {
      const href = r.link;
      return (
        <a
          key={r.key}
          href={href}
          className={cx(styles['link'], r.className)}
          style={r.style}
          rel="noreferrer noopener"
          target="_blank"
          onClick={(event) => {
            if (onLinkClick) {
              event.preventDefault();
              onLinkClick(href, event);
            }
          }}
        >
          {r.text}
        </a>
      );
    }
    // Search highlighting takes precedence over path detection: the two
    // features rewrite plain-text regions differently and the simplest
    // correct behaviour when both are on is "show the hit; the path link
    // would still be clickable on a non-highlighted line". This matches
    // Chrome's find-in-page, which suppresses hyperlink underlines
    // underneath a Ctrl+F hit to preserve legibility of the highlight.
    const hitsForSpan = perSpanHits ? (perSpanHits[i] ?? []) : [];
    if (hitsForSpan.length > 0) {
      const localActive = activeSpanIndex === i ? activeRangeIndex : null;
      return (
        <span key={r.key} className={r.className} style={r.style}>
          {renderSearchHighlightedText(r.text, hitsForSpan, localActive, i)}
        </span>
      );
    }
    if (onPathClick !== undefined || onUrlClick !== undefined) {
      return renderPlainSpanWithDetection(r, i, onPathClick, onUrlClick);
    }
    return (
      <span key={r.key} className={r.className} style={r.style}>
        {r.text}
      </span>
    );
  });

  return (
    <pre className={cx(styles['pre'], className)} style={wrapperStyle}>
      {children}
    </pre>
  );
}

/**
 * Memoized export. Parents must pass a stable `spans` reference across
 * renders for the memo to short-circuit; the block store does exactly that
 * (one array per block, replaced only when new bytes arrive).
 */
export const AnsiOutput = memo(AnsiOutputImpl);
AnsiOutput.displayName = 'AnsiOutput';
