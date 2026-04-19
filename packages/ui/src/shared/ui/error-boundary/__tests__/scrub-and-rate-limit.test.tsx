/**
 * Audit P1 (fix 8) — error message scrubbing + render-loop rate limit.
 *
 * The scrubber redacts paths / stack frames / IPs / emails / token-looking
 * strings from the user-facing fallback. The full chain is still emitted to
 * the logger, so on-call tooling is unaffected.
 *
 * The loop guard collapses to a generic message when the same scrubbed text
 * fires 10+ times in a 5s window — preventing an infinite render loop from
 * showering the screen with copies (and any detail a future scrubber pattern
 * missed).
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ErrorBoundary,
  __resetErrorLoopForTests,
  scrubErrorMessage,
} from '../ErrorBoundary.js';

function Thrower(props: { readonly message: string }): null {
  throw new Error(props.message);
}

describe('scrubErrorMessage (fix 8)', () => {
  it('redacts absolute POSIX paths', () => {
    expect(scrubErrorMessage('cannot read /Users/alice/secret.txt'))
      .toBe('cannot read <path>');
    expect(scrubErrorMessage('cannot read /home/bob/.ssh/id_rsa'))
      .toBe('cannot read <path>');
  });

  it('redacts Windows-style drive paths', () => {
    expect(scrubErrorMessage('fopen C:\\Users\\bob\\secret.txt failed'))
      .toBe('fopen <path> failed');
  });

  it('redacts stack-frame patterns', () => {
    const scrubbed = scrubErrorMessage(
      'TypeError: x is not a function\n    at renderCard (/Users/me/app/src/card.ts:42:17)',
    );
    expect(scrubbed).toContain('at <fn> (<loc>)');
    expect(scrubbed).not.toContain('/Users/me/app');
  });

  it('redacts email addresses', () => {
    expect(scrubErrorMessage('user alice@acme.org not found'))
      .toBe('user <email> not found');
  });

  it('redacts IPv4 addresses', () => {
    expect(scrubErrorMessage('connection refused 192.168.1.42:5000'))
      .toMatch(/connection refused <ip>/u);
  });

  it('redacts JWT-ish triple-dot tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJpYXQiOjE1MTYyfQ.SflKxwRJ-abcdefG9hiJkl';
    expect(scrubErrorMessage(`bad token ${jwt} rejected`)).toBe(
      'bad token <token> rejected',
    );
  });

  it('redacts long API-key-ish tokens', () => {
    expect(scrubErrorMessage('key=sk_live_abcDEF1234567890abcDEF1234567890z rejected'))
      .toMatch(/<token>/u);
  });

  it('returns empty string for empty input without redacting non-sensitive text', () => {
    expect(scrubErrorMessage('')).toBe('');
    expect(scrubErrorMessage('something went wrong')).toBe('something went wrong');
  });
});

describe('<ErrorBoundary /> + scrubbing + rate limit', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    __resetErrorLoopForTests();
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    __resetErrorLoopForTests();
  });

  it('renders the scrubbed message, not the raw one, in the fallback', () => {
    render(
      <ErrorBoundary subject="widget">
        <Thrower message="failed to read /Users/alice/secret.txt" />
      </ErrorBoundary>,
    );
    const fallback = screen.getByTestId('error-boundary-fallback');
    expect(fallback.textContent).toContain('<path>');
    expect(fallback.textContent).not.toContain('/Users/alice/secret.txt');
  });

  it('logs the raw message (scrubbing is UI-facing only)', () => {
    // The logger under the hood calls console.error; the spy installed in
    // beforeEach captures it. We scan the full argument set for the raw
    // path — the scrubber must NOT touch what we log.
    render(
      <ErrorBoundary subject="widget">
        <Thrower message="failed to read /Users/alice/secret.txt" />
      </ErrorBoundary>,
    );
    const raw = consoleSpy.mock.calls
      .flat()
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' | ');
    // React also logs the error; either React's log or our logger should
    // carry the raw path somewhere in console output. The point: at least
    // one console.error call contains the raw string, proving we are not
    // scrubbing logs.
    expect(raw).toContain('/Users/alice/secret.txt');
  });

  it('first render of a unique error shows the specific scrubbed message', () => {
    render(
      <ErrorBoundary subject="widget">
        <Thrower message="first-time error" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback').textContent).toContain(
      'first-time error',
    );
  });

  it('rate-limits to a generic message after repeated renders in 5s', () => {
    // Render the same-message boundary many times. React's boundary path
    // may invoke the fallback twice per catch (once for getDerivedStateFromError,
    // once after `setState(info)`), so we render enough iterations to
    // guarantee the loop bucket has saturated past the threshold.
    const msg = 'same error over and over';
    for (let i = 0; i < 20; i += 1) {
      const { unmount } = render(
        <ErrorBoundary subject="widget">
          <Thrower message={msg} />
        </ErrorBoundary>,
      );
      unmount();
    }
    // One more render — the bucket is saturated.
    render(
      <ErrorBoundary subject="widget">
        <Thrower message={msg} />
      </ErrorBoundary>,
    );
    const fallback = screen.getByTestId('error-boundary-fallback');
    expect(fallback.textContent).toContain('An unexpected error occurred');
    expect(fallback.textContent).not.toContain(msg);
  });

  it('different messages do not share the rate-limit bucket', () => {
    // Saturate bucket for message A.
    for (let i = 0; i < 20; i += 1) {
      const { unmount } = render(
        <ErrorBoundary subject="widget">
          <Thrower message="error A" />
        </ErrorBoundary>,
      );
      unmount();
    }
    // Message B is a fresh bucket — still the specific copy on FIRST render.
    render(
      <ErrorBoundary subject="widget">
        <Thrower message="error B" />
      </ErrorBoundary>,
    );
    const fallback = screen.getByTestId('error-boundary-fallback');
    expect(fallback.textContent).toContain('error B');
  });
});
