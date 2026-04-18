/**
 * ErrorBoundary tests.
 *
 * These tests deliberately silence `console.error` during the render where a
 * child throws — React logs internally and jsdom mirrors that to stderr. We
 * spy and restore so the test output stays readable.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorInfo } from 'react';

import { ErrorBoundary } from '../ErrorBoundary.js';

function Thrower(props: { readonly message?: string }): null {
  throw new Error(props.message ?? 'boom');
}

describe('<ErrorBoundary />', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders children normally when no error thrown', () => {
    render(
      <ErrorBoundary subject="widget">
        <div data-testid="child">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('renders the default fallback on a child throw and invokes onError', () => {
    const onError = vi.fn<(e: Error, info: ErrorInfo) => void>();
    render(
      <ErrorBoundary subject="widget" onError={onError}>
        <Thrower message="render-time kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(screen.getByText(/render-time kaboom/iu)).toBeInTheDocument();
    expect(screen.getByText(/widget/iu)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toBe('render-time kaboom');
  });

  it('Reload remounts the subtree (throw-then-recover)', () => {
    let shouldThrow = true;
    function Child(): JSX.Element {
      if (shouldThrow) throw new Error('first-render fail');
      return <div data-testid="recovered">ok</div>;
    }
    render(
      <ErrorBoundary subject="widget">
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    shouldThrow = false;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /reload/iu }));
    });
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
    expect(screen.getByTestId('recovered')).toHaveTextContent('ok');
  });

  it('Report invokes the onReport callback with the error', () => {
    const onReport = vi.fn<(e: Error, info: ErrorInfo) => void>();
    render(
      <ErrorBoundary subject="widget" onReport={onReport}>
        <Thrower message="report me" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /report/iu }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls[0]?.[0].message).toBe('report me');
  });

  it('uses a custom fallback when provided', () => {
    render(
      <ErrorBoundary
        subject="widget"
        fallback={(ctx) => <div data-testid="custom">oops: {ctx.error.message}</div>}
      >
        <Thrower message="x" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom')).toHaveTextContent('oops: x');
  });
});
