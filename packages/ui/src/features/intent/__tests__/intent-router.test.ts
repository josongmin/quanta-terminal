/**
 * Intent router — phase ordering, gate chain, rewrite chain, encode
 * fallback, async confirm. Plan 0005 P2-B.
 */
import { describe, expect, it, vi } from 'vitest';

import { createIntentRouter, makeIntent } from '../intent-router';
import type { AnyIntent } from '../intent-types';

function exec(text = 'echo hi'): AnyIntent {
  return makeIntent('execute', { text }, { source: 'user-keystroke' });
}

describe('intent-router', () => {
  it('makeIntent stamps user-keystroke confidence = 1.0', () => {
    const i = makeIntent('execute', { text: 'ls' }, { source: 'user-keystroke' });
    expect(i.confidence).toBe(1.0);
    expect(i.source).toBe('user-keystroke');
    expect(typeof i.originatingTs).toBe('number');
  });

  it('makeIntent defaults agent confidence to 0.7', () => {
    const i = makeIntent('execute', { text: 'ls' }, { source: 'agent' });
    expect(i.confidence).toBe(0.7);
  });

  it('dispatches through inspect → encode when no gates/rewriters', async () => {
    const bytes: Uint8Array[] = [];
    const router = createIntentRouter({ onBytes: (b) => bytes.push(b) });
    const inspectCalls: AnyIntent[] = [];
    router.subscribeInspect((i) => inspectCalls.push(i));
    router.subscribeEncode(() => new Uint8Array([1, 2, 3]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('delivered');
    expect(bytes).toHaveLength(1);
    expect(inspectCalls).toHaveLength(1);
  });

  it('gates run in insertion order and first deny wins, onDeny fires once', async () => {
    const onDeny = vi.fn();
    const router = createIntentRouter({ onDeny });
    const secondGate = vi.fn(() => 'allow' as const);
    router.subscribeGate(() => 'deny');
    router.subscribeGate(secondGate);
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('denied');
    // Second gate should NOT have been called because first wins.
    expect(secondGate).not.toHaveBeenCalled();
    // onDeny fires exactly once with the original intent payload.
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny.mock.calls[0]![0]).toMatchObject({
      kind: 'execute',
      payload: { text: 'echo hi' },
    });
  });

  it('allow + confirm → prompts via onConfirm hook (allowed)', async () => {
    const onConfirm = vi.fn(async () => true);
    const router = createIntentRouter({ onConfirm });
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(() => new Uint8Array([42]));
    const result = await router.dispatch(exec());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('delivered');
  });

  it('confirm hook rejecting → outcome confirmed-denied', async () => {
    const onConfirm = vi.fn(async () => false);
    const router = createIntentRouter({ onConfirm });
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(() => new Uint8Array([42]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('confirmed-denied');
  });

  it('confirm without onConfirm hook fails CLOSED (confirmed-denied)', async () => {
    // Regression guard: a missing confirm hook MUST NOT deliver the
    // intent. A forgotten onConfirm should never accidentally bypass
    // the safety-gate prompt.
    const onDeny = vi.fn();
    const router = createIntentRouter({ onDeny });
    const encode = vi.fn(() => new Uint8Array([1]));
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(encode);
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('confirmed-denied');
    // Encoders must NOT run when confirm fails closed.
    expect(encode).not.toHaveBeenCalled();
    // onDeny surfaces the missing-hook reason so callers can log it.
    expect(onDeny).toHaveBeenCalledWith(expect.anything(), 'confirm hook missing');
  });

  it('confirm without onConfirm hook ALLOWS with allowWithoutConfirmHook opt-in', async () => {
    // Explicit escape hatch for tests / headless harnesses. Must be
    // opt-in, default is the fail-closed path above.
    const router = createIntentRouter({ allowWithoutConfirmHook: true });
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(() => new Uint8Array([1]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('delivered');
  });

  it('rewriters chain in insertion order', async () => {
    const router = createIntentRouter();
    router.subscribeRewrite((i) => {
      if (i.kind === 'execute') {
        return { ...i, payload: { text: i.payload.text + ' A' } };
      }
      return i;
    });
    router.subscribeRewrite((i) => {
      if (i.kind === 'execute') {
        return { ...i, payload: { text: i.payload.text + ' B' } };
      }
      return i;
    });
    let finalText = '';
    router.subscribeEncode((i) => {
      if (i.kind === 'execute') finalText = i.payload.text;
      return new Uint8Array([0]);
    });
    await router.dispatch(exec('start'));
    expect(finalText).toBe('start A B');
  });

  it('rewriter returning null drops the intent', async () => {
    const router = createIntentRouter();
    const encode = vi.fn(() => new Uint8Array([1]));
    router.subscribeRewrite(() => null);
    router.subscribeEncode(encode);
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('dropped');
    expect(encode).not.toHaveBeenCalled();
  });

  it('encode fallback — first non-null wins, later encoders untried', async () => {
    const router = createIntentRouter();
    const first = vi.fn(() => null);
    const second = vi.fn(() => new Uint8Array([7]));
    const third = vi.fn(() => new Uint8Array([99]));
    router.subscribeEncode(first);
    router.subscribeEncode(second);
    router.subscribeEncode(third);
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('delivered');
    expect(result.bytes).toEqual(new Uint8Array([7]));
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
  });

  it('no encoder → outcome no-encoder', async () => {
    const router = createIntentRouter();
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('no-encoder');
  });

  it('onDeny hook fires on deny', async () => {
    const onDeny = vi.fn();
    const router = createIntentRouter({ onDeny });
    router.subscribeGate(() => 'deny');
    await router.dispatch(exec());
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('inspect errors do NOT break dispatch', async () => {
    const router = createIntentRouter();
    router.subscribeInspect(() => {
      throw new Error('observer bug');
    });
    router.subscribeEncode(() => new Uint8Array([1]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('delivered');
  });

  it('gate throwing → fail-closed deny', async () => {
    const onDeny = vi.fn();
    const router = createIntentRouter({ onDeny });
    router.subscribeGate(() => {
      throw new Error('boom');
    });
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('denied');
    expect(onDeny).toHaveBeenCalledWith(expect.anything(), 'gate threw');
  });

  it('rewriter throwing → drop', async () => {
    const router = createIntentRouter();
    router.subscribeRewrite(() => {
      throw new Error('boom');
    });
    router.subscribeEncode(() => new Uint8Array([1]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('dropped');
  });

  it('encoder throwing → tries next encoder', async () => {
    const router = createIntentRouter();
    router.subscribeEncode(() => {
      throw new Error('boom');
    });
    router.subscribeEncode(() => new Uint8Array([9]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('delivered');
    expect(result.bytes).toEqual(new Uint8Array([9]));
  });

  it('unsubscribe removes inspector from chain', async () => {
    const router = createIntentRouter();
    const calls: number[] = [];
    const unsub = router.subscribeInspect(() => calls.push(1));
    router.subscribeInspect(() => calls.push(2));
    router.subscribeEncode(() => new Uint8Array([0]));
    await router.dispatch(exec());
    expect(calls).toEqual([1, 2]);
    unsub();
    await router.dispatch(exec());
    expect(calls).toEqual([1, 2, 2]);
  });

  it('unsubscribe removes gate', async () => {
    const router = createIntentRouter();
    const unsub = router.subscribeGate(() => 'deny');
    router.subscribeEncode(() => new Uint8Array([1]));
    expect((await router.dispatch(exec())).outcome).toBe('denied');
    unsub();
    expect((await router.dispatch(exec())).outcome).toBe('delivered');
  });

  it('async gate confirm hook (promise) resolves correctly', async () => {
    let resolve!: (b: boolean) => void;
    const onConfirm = () =>
      new Promise<boolean>((r) => {
        resolve = r;
      });
    const router = createIntentRouter({ onConfirm });
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(() => new Uint8Array([5]));
    const p = router.dispatch(exec());
    resolve(true);
    const result = await p;
    expect(result.outcome).toBe('delivered');
  });

  it('phase order is deterministic: inspect → gate → rewrite → encode', async () => {
    const order: string[] = [];
    const router = createIntentRouter();
    router.subscribeEncode(() => {
      order.push('encode');
      return new Uint8Array([1]);
    });
    router.subscribeRewrite((i) => {
      order.push('rewrite');
      return i;
    });
    router.subscribeGate(() => {
      order.push('gate');
      return 'allow';
    });
    router.subscribeInspect(() => order.push('inspect'));
    await router.dispatch(exec());
    expect(order).toEqual(['inspect', 'gate', 'rewrite', 'encode']);
  });

  it('onBytes receives the final (post-rewrite) intent', async () => {
    let seen!: AnyIntent;
    const router = createIntentRouter({
      onBytes: (_b, i) => {
        seen = i;
      },
    });
    router.subscribeRewrite((i) => {
      if (i.kind === 'execute') {
        return { ...i, payload: { text: 'rewritten' } };
      }
      return i;
    });
    router.subscribeEncode(() => new Uint8Array([1]));
    await router.dispatch(exec('original'));
    expect(seen.kind).toBe('execute');
    if (seen.kind === 'execute') {
      expect(seen.payload.text).toBe('rewritten');
    }
  });

  it('confirm hook throwing → outcome confirmed-denied', async () => {
    const router = createIntentRouter({
      onConfirm: () => {
        throw new Error('modal crashed');
      },
    });
    router.subscribeGate(() => 'confirm');
    router.subscribeEncode(() => new Uint8Array([1]));
    const result = await router.dispatch(exec());
    expect(result.outcome).toBe('confirmed-denied');
  });
});
