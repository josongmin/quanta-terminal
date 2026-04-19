/**
 * main.tsx wiring tests (FIX 4).
 *
 * The entry point installs three slots on startup: the unhandled-rejection
 * handler, the crash reporter (production only), and the updater banner.
 * These tests exercise the exported `postCrashReport` adapter — the hook
 * that turns an unhandled reason into a `quanta_report_crash` IPC call.
 * The full boot sequence isn't exercised here (the DOM mount + bridge
 * factory have their own tests); we care about the crash-forward path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Tauri invoke surface BEFORE importing main.
const invokeSpy = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(
  async () => undefined,
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeSpy(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
// The UI bootstrap pulls in the whole React tree; short-circuit it for this
// unit test. The wiring test is deliberately decoupled from UI rendering.
vi.mock('@quanta/ui', () => ({
  bootstrapUi: vi.fn(),
}));

// main.tsx's top-level `void main()` is gated on the presence of a
// `#quanta-root` mount point; jsdom starts without one, so importing
// the module is side-effect-free for the purposes of this test.
import { postCrashReport } from '../main.js';

describe('postCrashReport', () => {
  beforeEach(() => {
    invokeSpy.mockClear();
    invokeSpy.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    invokeSpy.mockReset();
  });

  it('forwards an Error to quanta_report_crash with kind + message + stack', () => {
    const err = new Error('kaboom');
    err.name = 'BoomError';
    postCrashReport(err);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const firstCall = invokeSpy.mock.calls[0];
    if (!firstCall) throw new Error('invoke was not called');
    const [cmd, rawPayload] = firstCall as [
      string,
      { report: Record<string, unknown> } | undefined,
    ];
    if (!rawPayload) throw new Error('invoke payload missing');
    const payload = rawPayload;
    expect(cmd).toBe('quanta_report_crash');
    expect(payload.report).toMatchObject({
      kind: 'BoomError',
      message: 'kaboom',
      origin: 'ts.unhandled',
    });
    expect(typeof payload.report.stack).toBe('string');
  });

  it('handles a string reason without a stack', () => {
    postCrashReport('bare string');
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const firstCall = invokeSpy.mock.calls[0];
    if (!firstCall) throw new Error('invoke was not called');
    const payload = firstCall[1] as { report: Record<string, unknown> } | undefined;
    if (!payload) throw new Error('invoke payload missing');
    expect(payload.report.kind).toBe('string');
    expect(payload.report.message).toBe('bare string');
    expect(payload.report.stack).toBeNull();
  });

  it('does not throw when invoke itself rejects', async () => {
    invokeSpy.mockImplementation(async () => {
      throw new Error('tauri bridge down');
    });
    // Sync call must not throw; the rejection is swallowed internally.
    expect(() => postCrashReport(new Error('x'))).not.toThrow();
    // Flush the microtask queue so the rejected promise has a chance to hit
    // the internal `.catch` — if it somehow escaped we'd see an unhandled
    // rejection logged by vitest.
    await Promise.resolve();
  });
});
