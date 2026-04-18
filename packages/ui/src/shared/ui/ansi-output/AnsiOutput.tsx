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
import styles from './ansi-output.module.css';
import { indexed256ToCss } from './palette.js';
import type { AnsiColor, AnsiSpan } from './types.js';

/** Payload delivered to `onPathClick` when the user activates a detected file link. */
export interface PathClickPayload {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
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
   * If true, `\r` and `\x08` rewrite / erase visible text as a real terminal
   * would. Defaults to false because for most build output CR/BS are noise
   * left over from interactive shells. Progress-bar-heavy workloads (pnpm
   * install, wget) should pass `true`.
   */
  readonly carriageReturnRewrites?: boolean;
  /** Additional class on the <pre> wrapper (tests / block chrome integration). */
  readonly className?: string;
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
 */
function applyControlChars(text: string, rewrites: boolean): string {
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
 * When `onPathClick` is enabled and a plain span's text contains any detected
 * `path:line[:col]` runs, splice the text into interleaved `<span>` + `<button>`
 * nodes so the click target is keyboard-focusable without losing the
 * surrounding SGR styling (class/style come from the parent span).
 */
function renderPlainSpanWithPathDetection(
  r: RenderedSpan,
  keyPrefix: number,
  onPathClick: NonNullable<AnsiOutputProps['onPathClick']>,
): ReactNode {
  const fragments = splitTextByPaths(r.text);
  if (fragments.length === 1) {
    // No hits → fall back to the plain path.
    return (
      <span key={r.key} className={r.className} style={r.style}>
        {r.text}
      </span>
    );
  }
  const children: ReactNode[] = [];
  let frag = 0;
  for (const f of fragments) {
    if (f.kind === 'text') {
      if (f.text.length > 0) {
        children.push(
          // The parent span conveys the SGR styling; the inner text node is
          // a bare string (no wrapping) so selection and copy-paste continue
          // to feel like raw terminal output.
          <span key={`${keyPrefix}-t${frag}`}>{f.text}</span>,
        );
      }
    } else {
      children.push(renderPathButton(f.hit, `${keyPrefix}-p${frag}`, onPathClick));
    }
    frag += 1;
  }
  return (
    <span key={r.key} className={r.className} style={r.style}>
      {children}
    </span>
  );
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

function AnsiOutputImpl(props: AnsiOutputProps) {
  const { spans, onLinkClick, onPathClick, carriageReturnRewrites = false, className, maxWidth } =
    props;

  const wrapperStyle: CSSProperties | undefined =
    maxWidth !== undefined ? { maxWidth: `${maxWidth}ch` } : undefined;

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
    if (onPathClick !== undefined) {
      return renderPlainSpanWithPathDetection(r, i, onPathClick);
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
