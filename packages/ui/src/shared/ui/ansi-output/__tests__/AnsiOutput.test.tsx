/**
 * <AnsiOutput /> — renders AnsiSpan[] into a styled <pre>.
 *
 * Tests cover:
 *   - SGR → class / inline-style mapping (every tone).
 *   - OSC 8 → anchor with rel + onClick + preventDefault.
 *   - Control-char handling (default strip vs rewrite mode).
 *   - Memoization (stable span reference → no re-render cost explosion).
 *   - DOM-node count is bounded (no O(n²) churn on 10k spans).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BACKSPACE_MARKER } from '../../../lib/ansi-parser/index.js';
import { AnsiOutput } from '../AnsiOutput.js';
import type { AnsiSpan } from '../types.js';

function renderSpans(spans: AnsiSpan[]) {
  return render(<AnsiOutput spans={spans} />);
}

describe('<AnsiOutput />', () => {
  it('renders plain text as a single span inside a <pre>', () => {
    const { container } = renderSpans([{ text: 'hello' }]);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('hello');
  });

  it('applies a bold class for bold spans', () => {
    const { container } = renderSpans([{ text: 'b', bold: true }]);
    const span = container.querySelector('span');
    expect(span?.className).toMatch(/bold/u);
  });

  it.each([
    ['italic', { italic: true }],
    ['underline', { underline: true }],
    ['dim', { dim: true }],
    ['strike', { strike: true }],
    ['hidden', { hidden: true }],
  ] as const)('applies a %s class', (name, attrs) => {
    const { container } = renderSpans([{ text: 'x', ...attrs }]);
    expect(container.querySelector('span')?.className).toMatch(new RegExp(name, 'u'));
  });

  it('named foreground colors get a fg-named-N class', () => {
    const { container } = renderSpans([
      { text: 'r', fg: { kind: 'named', index: 1 } },
    ]);
    expect(container.querySelector('span')?.className).toMatch(/fg-named-1/u);
  });

  it('bright background colors get a bg-bright-N class', () => {
    const { container } = renderSpans([
      { text: 'x', bg: { kind: 'bright', index: 4 } },
    ]);
    expect(container.querySelector('span')?.className).toMatch(/bg-bright-4/u);
  });

  it('indexed colors use inline style with rgb(...)', () => {
    const { container } = renderSpans([
      { text: 'x', fg: { kind: 'indexed', index: 196 } },
    ]);
    const span = container.querySelector('span')!;
    expect(span.getAttribute('style')).toContain('rgb(');
  });

  it('truecolor uses inline rgb(r, g, b)', () => {
    const { container } = renderSpans([
      { text: 'x', fg: { kind: 'rgb', r: 10, g: 20, b: 30 } },
    ]);
    expect(container.querySelector('span')?.getAttribute('style')).toContain('rgb(10, 20, 30)');
  });

  it('default color leaves the pre color to inherit', () => {
    const { container } = renderSpans([{ text: 'x', fg: { kind: 'default' } }]);
    const span = container.querySelector('span')!;
    // No fg-* class, no inline color.
    expect(span.className).not.toMatch(/fg-named/u);
    expect(span.getAttribute('style') ?? '').not.toContain('color:');
  });

  it('inverse with no explicit colors flips fg/bg via inline style', () => {
    const { container } = renderSpans([{ text: 'x', inverse: true }]);
    const style = container.querySelector('span')?.getAttribute('style') ?? '';
    expect(style).toContain('color');
    expect(style).toContain('background-color');
  });

  it('inverse with explicit fg+bg swaps the two', () => {
    const { container } = renderSpans([
      {
        text: 'x',
        fg: { kind: 'named', index: 1 },
        bg: { kind: 'named', index: 2 },
        inverse: true,
      },
    ]);
    // Fg should now be the green class (was bg=2), bg should be the red class.
    const cls = container.querySelector('span')?.className ?? '';
    expect(cls).toMatch(/fg-named-2/u);
    expect(cls).toMatch(/bg-named-1/u);
  });
});

describe('<AnsiOutput /> — OSC 8 hyperlinks', () => {
  it('renders a span with `link` as an <a> with rel and target attrs', () => {
    renderSpans([{ text: 'click', link: 'https://example.com/' }]);
    const a = screen.getByRole('link');
    expect(a).toHaveAttribute('href', 'https://example.com/');
    expect(a).toHaveAttribute('rel', 'noreferrer noopener');
    expect(a).toHaveAttribute('target', '_blank');
  });

  it('invokes onLinkClick with the href and preventsDefault navigation', async () => {
    const spy = vi.fn();
    render(
      <AnsiOutput
        spans={[{ text: 'click', link: 'https://example.com/' }]}
        onLinkClick={spy}
      />,
    );
    const a = screen.getByRole('link');
    await userEvent.click(a);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('https://example.com/');
  });

  it('without onLinkClick, the anchor navigates normally (no preventDefault)', () => {
    // Not a real navigation (jsdom), but we can verify no wrapper handler
    // calls preventDefault — i.e. defaultPrevented stays false after click.
    render(<AnsiOutput spans={[{ text: 'c', link: 'https://ex.com' }]} />);
    const a = screen.getByRole('link');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('applies SGR styling to the anchor alongside the link role', () => {
    renderSpans([
      {
        text: 'c',
        link: 'https://x',
        fg: { kind: 'named', index: 3 },
        bold: true,
      },
    ]);
    const a = screen.getByRole('link');
    expect(a.className).toMatch(/fg-named-3/u);
    expect(a.className).toMatch(/bold/u);
  });
});

describe('<AnsiOutput /> — control characters', () => {
  it('default mode strips backspace sentinels silently', () => {
    const { container } = renderSpans([{ text: `ab${BACKSPACE_MARKER}c` }]);
    expect(container.textContent).toBe('abc');
  });

  it('default mode leaves CR in place (no rewrite)', () => {
    const { container } = renderSpans([{ text: 'line1\rline2' }]);
    expect(container.textContent).toBe('line1\rline2');
  });

  it('rewrite mode erases the previous character on BS', () => {
    const { container } = render(
      <AnsiOutput
        spans={[{ text: `ab${BACKSPACE_MARKER}c` }]}
        carriageReturnRewrites={true}
      />,
    );
    expect(container.textContent).toBe('ac');
  });

  it('rewrite mode collapses CR-rewritten progress bar to the final frame', () => {
    const { container } = render(
      <AnsiOutput
        spans={[{ text: '[=   ] 25%\r[===  ] 60%\r[=====] 100%\n' }]}
        carriageReturnRewrites={true}
      />,
    );
    expect(container.textContent).toBe('[=====] 100%\n');
  });

  it('rewrite mode keeps lines across \\n boundaries', () => {
    const { container } = render(
      <AnsiOutput
        spans={[{ text: 'first\nabc\rXY' }]}
        carriageReturnRewrites={true}
      />,
    );
    expect(container.textContent).toBe('first\nXY');
  });
});

describe('<AnsiOutput /> — path detection (Phase 3)', () => {
  it('does NOT create buttons when onPathClick is absent', () => {
    const { container } = renderSpans([{ text: 'see src/main.rs:12:3 please' }]);
    expect(container.querySelector('button')).toBeNull();
  });

  it('wraps a detected path in a button when onPathClick is provided', () => {
    const spy = vi.fn();
    render(
      <AnsiOutput spans={[{ text: 'see src/main.rs:12:3 please' }]} onPathClick={spy} />,
    );
    const btn = screen.getByRole('button', { name: /src\/main\.rs:12:3/u });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-path')).toBe('src/main.rs');
    expect(btn.getAttribute('data-line')).toBe('12');
    expect(btn.getAttribute('data-column')).toBe('3');
  });

  it('fires onPathClick with the parsed {path, line, column} on click', async () => {
    const spy = vi.fn();
    render(
      <AnsiOutput
        spans={[{ text: 'error at src/lib.rs:42:7 — mismatch' }]}
        onPathClick={spy}
      />,
    );
    const btn = screen.getByRole('button', { name: /src\/lib\.rs:42:7/u });
    await userEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ path: 'src/lib.rs', line: 42, column: 7 });
  });

  it('omits column from the payload when the detected match has none', async () => {
    const spy = vi.fn();
    render(<AnsiOutput spans={[{ text: 'src/index.ts:42' }]} onPathClick={spy} />);
    const btn = screen.getByRole('button', { name: /src\/index\.ts:42/u });
    await userEvent.click(btn);
    expect(spy.mock.calls[0]![0]).toEqual({ path: 'src/index.ts', line: 42 });
  });

  it('stops propagation so enclosing toggles are not triggered', () => {
    const spy = vi.fn();
    const outer = vi.fn();
    const { container } = render(
      <div onClick={outer}>
        <AnsiOutput spans={[{ text: 'src/a.ts:1:2' }]} onPathClick={spy} />
      </div>,
    );
    const btn = container.querySelector('button')!;
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('renders multiple path buttons interleaved with text', () => {
    const spy = vi.fn();
    render(
      <AnsiOutput
        spans={[{ text: 'see a.ts:1:2 and b.ts:3:4 end' }]}
        onPathClick={spy}
      />,
    );
    const btns = screen.getAllByRole('button');
    expect(btns.length).toBe(2);
    expect(btns[0]!.textContent).toBe('a.ts:1:2');
    expect(btns[1]!.textContent).toBe('b.ts:3:4');
  });

  it('preserves SGR styling on the parent span even when a path is detected', () => {
    const spy = vi.fn();
    const { container } = render(
      <AnsiOutput
        spans={[
          {
            text: 'error at src/lib.rs:12:3',
            fg: { kind: 'named', index: 1 },
            bold: true,
          },
        ]}
        onPathClick={spy}
      />,
    );
    // Outer span carries the SGR classes; the button inherits color via CSS.
    const outerSpan = container.querySelector('span');
    expect(outerSpan?.className).toMatch(/fg-named-1/u);
    expect(outerSpan?.className).toMatch(/bold/u);
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('does not wrap URL-shaped text into a path button', () => {
    const spy = vi.fn();
    render(
      <AnsiOutput
        spans={[{ text: 'open https://example.com:8080/foo' }]}
        onPathClick={spy}
      />,
    );
    // No button should be rendered — the detector rejects URLs.
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('<AnsiOutput /> — performance', () => {
  it('renders 10 000 spans without producing more DOM nodes than spans', () => {
    const spans: AnsiSpan[] = Array.from({ length: 10_000 }, (_, i) => ({
      text: `x${i} `,
      fg: { kind: 'named', index: (i % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6 },
    }));
    const { container } = render(<AnsiOutput spans={spans} />);
    const pre = container.querySelector('pre')!;
    // One child per span — linear DOM, no wrapping tree.
    expect(pre.childElementCount).toBe(spans.length);
  });

  it('memo: same span reference → the child list identity persists across rerenders', () => {
    const spans: AnsiSpan[] = [{ text: 'a' }, { text: 'b' }];
    const { container, rerender } = render(<AnsiOutput spans={spans} />);
    const firstPre = container.querySelector('pre');
    rerender(<AnsiOutput spans={spans} />);
    const secondPre = container.querySelector('pre');
    // React.memo with stable props shouldn't rebuild the <pre> node.
    expect(firstPre).toBe(secondPre);
  });
});
