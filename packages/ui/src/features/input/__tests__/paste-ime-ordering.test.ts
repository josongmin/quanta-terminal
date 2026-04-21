/**
 * Tests for Bug 1 (paste during active IME composition — state-agnostic,
 * paste proceeds immediately without disrupting the composition) and
 * Bug 2 (paste gate error surfaced via console.warn).
 *
 * Per ADR 0018 and the pinned e2e behavior: the paste handler is
 * state-agnostic. Paste bytes are emitted synchronously while the IME
 * composition remains active. The composition can still be committed or
 * cancelled afterward. This avoids surprising cancellation of in-progress
 * input and is intentional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Focus } from '../Focus';
import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import { Paste } from '../Paste';
import { mount } from '../input-host';

function setup(overrides: Partial<Parameters<typeof mount>[1]> = {}) {
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

function firePaste(container: HTMLElement, text: string): void {
  // jsdom does not implement DataTransfer; mirror the e2e test pattern of
  // using a plain Event with a manually-attached clipboardData shim.
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
  container.dispatchEvent(ev);
}

describe('Bug 1 — paste during active IME composition (state-agnostic)', () => {
  it('paste is emitted immediately without cancelling the ongoing composition', () => {
    const { container, handle, bytesOut } = setup();

    // Start a composition
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    expect(handle.state().kind).toBe('Composing');

    // Fire a paste while composing — it should be emitted immediately
    firePaste(container, 'hello');

    // Paste bytes must have been emitted
    expect(bytesOut.length).toBeGreaterThan(0);

    // IME composition remains active — paste does NOT cancel it
    // (this is the pinned behavior per ADR 0018 and ime-bracketed-paste e2e)
    expect(handle.state().kind).toBe('Composing');

    handle.unmount();
  });

  it('IME commit can still happen after paste during composition', () => {
    const { container, handle, bytesOut } = setup();

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));

    firePaste(container, 'hi');

    const afterPaste = bytesOut.length;
    expect(afterPaste).toBeGreaterThan(0);

    // Commit IME after paste — additional bytes emitted
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    expect(bytesOut.length).toBeGreaterThan(afterPaste);
    expect(handle.state().kind).toBe('Idle');

    handle.unmount();
  });

  it('empty paste during composition emits no bytes and leaves composition active', () => {
    const { container, handle, bytesOut } = setup();

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));

    const before = bytesOut.length;
    firePaste(container, '');

    // Empty paste: no bytes emitted
    expect(bytesOut.length).toBe(before);
    // Composition still active
    expect(handle.state().kind).toBe('Composing');

    handle.unmount();
  });
});

describe('Bug 2 — paste gate error surfaced via console.warn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('discards paste and emits console.warn when gate throws', async () => {
    const { container, handle, bytesOut } = setup({
      onPasteGate: () => Promise.reject(new Error('gate exploded')),
    });

    firePaste(container, 'secret');

    // Let the rejected promise settle
    await new Promise<void>((r) => setTimeout(r, 0));

    // No bytes emitted
    expect(bytesOut.length).toBe(0);

    // console.warn must have been called with the paste-gate marker
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[paste-gate]'),
      expect.any(Error),
    );

    handle.unmount();
  });

  it('processes paste normally when onPasteGate is not set', () => {
    const { container, handle, bytesOut } = setup({});

    firePaste(container, 'hello');

    expect(bytesOut.length).toBeGreaterThan(0);
    handle.unmount();
  });
});
