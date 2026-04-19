/**
 * Global unhandled-rejection / error handler tests (FIX 3, P0).
 *
 * We exercise the pure `handleUnhandledReason` entry point directly so the
 * tests don't depend on the browser's actual event dispatch semantics — which
 * jsdom fakes with varying fidelity. A fourth test also drives the full
 * `installUnhandledRejectionHandlers` path end-to-end to catch wiring bugs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleUnhandledReason,
  installUnhandledRejectionHandlers,
  setCrashReporter,
  setUnhandledRejectionLogger,
  setUnhandledRejectionToast,
} from '../unhandled-rejection.js';

describe('handleUnhandledReason', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset module state between tests.
    setUnhandledRejectionToast(null);
    setCrashReporter(null);
    setUnhandledRejectionLogger(null);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs the reason through the registered logger', () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    setUnhandledRejectionLogger(logger);
    handleUnhandledReason(new Error('boom'), 'promise');
    expect(logger.error).toHaveBeenCalled();
    const call = logger.error.mock.calls[0] as [string, unknown];
    const [msg, ctx] = call;
    expect(msg).toMatch(/unhandled promise/i);
    expect(msg).toMatch(/boom/);
    expect((ctx as Error).message).toBe('boom');
  });

  it('dispatches to the toast hook when one is registered', () => {
    const toast = vi.fn();
    setUnhandledRejectionToast(toast);
    handleUnhandledReason('something failed', 'promise');
    expect(toast).toHaveBeenCalledTimes(1);
    const call = toast.mock.calls[0] as [string, unknown];
    expect(call[0]).toBe('something failed');
  });

  it('invokes the crash reporter hook in addition to the logger', () => {
    const reporter = vi.fn();
    setCrashReporter(reporter);
    handleUnhandledReason({ any: 'shape' }, 'error');
    expect(reporter).toHaveBeenCalledWith({ any: 'shape' });
  });

  it('swallows throws from the toast handler without re-raising', () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    setUnhandledRejectionLogger(logger);
    setUnhandledRejectionToast(() => {
      throw new Error('toast impl broken');
    });
    // No expect().not.toThrow wrapper — the mere fact that the test proceeds
    // is the assertion.
    handleUnhandledReason('x', 'promise');
    // The breakage is logged, not re-raised.
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls[0] as [string, unknown];
    expect(warnCall[0]).toMatch(/toast/i);
  });

  it('swallows throws from the crash reporter', () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    setUnhandledRejectionLogger(logger);
    setCrashReporter(() => {
      throw new Error('reporter broken');
    });
    handleUnhandledReason('x', 'error');
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls[0] as [string, unknown];
    expect(warnCall[0]).toMatch(/crash/i);
  });
});

describe('installUnhandledRejectionHandlers (wiring)', () => {
  let logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let detach: (() => void) | null = null;

  beforeEach(() => {
    logger = { error: vi.fn(), warn: vi.fn() };
    setUnhandledRejectionLogger(logger);
    setUnhandledRejectionToast(null);
    setCrashReporter(null);
    detach = installUnhandledRejectionHandlers(window);
  });

  afterEach(() => {
    if (detach) detach();
    setUnhandledRejectionLogger(null);
  });

  it('responds to a dispatched unhandledrejection event', () => {
    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: new Error('rej'), configurable: true });
    window.dispatchEvent(ev);
    expect(logger.error).toHaveBeenCalled();
    const call = logger.error.mock.calls[0] as [string, unknown];
    expect(call[0]).toMatch(/rej/);
  });

  it('responds to a dispatched error event', () => {
    const ev = new ErrorEvent('error', { error: new Error('sync-boom'), message: 'sync-boom' });
    window.dispatchEvent(ev);
    expect(logger.error).toHaveBeenCalled();
    const call = logger.error.mock.calls[0] as [string, unknown];
    expect(call[0]).toMatch(/sync-boom/);
  });
});
