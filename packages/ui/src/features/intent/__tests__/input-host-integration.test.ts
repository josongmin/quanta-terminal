/**
 * input-host ↔ intent router integration — Plan 0005 P2-B.
 *
 * Confirms that when the `intentLayerEnabled` flag is ON and a router
 * is passed, Ctrl+C/Ctrl+Z keystrokes route through the intent layer
 * (NOT the encoder) and that the flag OFF path is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { Focus } from '../../input/Focus';
import { KeyEncoder } from '../../input/KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../../input/ModeSnapshot';
import { MouseEncoder } from '../../input/MouseEncoder';
import { Paste } from '../../input/Paste';
import { mount } from '../../input/input-host';
import { createDefaultEncoder } from '../built-in/default-encoder';
import { createIntentRouter } from '../intent-router';
import type { AnyIntent } from '../intent-types';

function setup(
  overrides: Partial<Parameters<typeof mount>[1]> = {},
): {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
} {
  const mirror = createStubMirror();
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });
  const bytesOut: Uint8Array[] = [];

  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'macos',
    onBytesOut: (b) => bytesOut.push(b),
    ...overrides,
  });

  return { container, handle, bytesOut };
}

describe('input-host ↔ intent router integration', () => {
  it('flag OFF: Ctrl+C still flows through the encoder path (baseline)', () => {
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    // Legacy encoder emits ^C = 0x03.
    expect(bytesOut.length).toBeGreaterThan(0);
    expect(bytesOut[0]![0]).toBe(0x03);
    handle.unmount();
  });

  it('flag ON: Ctrl+C routes as an interrupt intent (NOT encoder)', async () => {
    const dispatched: AnyIntent[] = [];
    const router = createIntentRouter();
    router.subscribeInspect((i) => dispatched.push(i));
    router.subscribeEncode(createDefaultEncoder());

    const { container, handle, bytesOut } = setup({
      intentRouter: router,
      intentLayerEnabled: true,
    });

    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    // Dispatch is async — give the microtask queue a tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.kind).toBe('interrupt');
    // Encoder path was skipped — no byte emission from the synchronous
    // KeyEncoder call (the router delivery goes through onBytes of the
    // router, which we didn't wire to onBytesOut in this test).
    expect(bytesOut).toHaveLength(0);
    handle.unmount();
  });

  it('flag ON: Ctrl+Z routes as a suspend intent', async () => {
    const dispatched: AnyIntent[] = [];
    const router = createIntentRouter();
    router.subscribeInspect((i) => dispatched.push(i));
    router.subscribeEncode(createDefaultEncoder());

    const { container, handle } = setup({
      intentRouter: router,
      intentLayerEnabled: true,
    });

    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await Promise.resolve();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.kind).toBe('suspend');
    handle.unmount();
  });

  it('flag ON: non-interrupt keys still use the encoder path', () => {
    const router = createIntentRouter();
    router.subscribeEncode(createDefaultEncoder());
    const { container, handle, bytesOut } = setup({
      intentRouter: router,
      intentLayerEnabled: true,
    });

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(1);
    expect(bytesOut[0]![0]).toBe(0x61); // 'a'
    handle.unmount();
  });

  it('default encoder converts `execute` → bracketed-paste bytes + CR', () => {
    const encode = createDefaultEncoder();
    const intent: AnyIntent = {
      kind: 'execute',
      payload: { text: 'ls' },
      source: 'palette',
      confidence: 1.0,
      originatingTs: 0,
    };
    const bytes = encode(intent);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBeGreaterThan(0);
    // Last byte is CR.
    expect(bytes![bytes!.length - 1]).toBe(0x0d);
    // Contains payload 'ls' after the bracketed-paste start sentinel
    // (BP_START is 6 bytes: ESC [ 2 0 0 ~).
    expect(bytes![6]).toBe(0x6c); // 'l'
    expect(bytes![7]).toBe(0x73); // 's'
  });

  it('default encoder converts `interrupt` → 0x03 single byte', () => {
    const encode = createDefaultEncoder();
    const bytes = encode({
      kind: 'interrupt',
      payload: {},
      source: 'user-keystroke',
      confidence: 1.0,
      originatingTs: 0,
    });
    expect(bytes).toEqual(new Uint8Array([0x03]));
  });

  it('default encoder returns null for `ai-explain` (UI-only intent)', () => {
    const encode = createDefaultEncoder();
    const bytes = encode({
      kind: 'ai-explain',
      payload: { runId: 'r1' },
      source: 'palette',
      confidence: 1.0,
      originatingTs: 0,
    });
    expect(bytes).toBeNull();
  });
});
