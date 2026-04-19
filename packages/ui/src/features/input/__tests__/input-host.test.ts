import { describe, expect, it } from 'vitest';

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
  const overlays: (ReturnType<typeof Object> | null)[] = [];
  const banners: string[] = [];

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
    onOverlayUpdate: (o) => overlays.push(o),
    onBanner: (m) => banners.push(m),
    ...overrides,
  });

  return { container, handle, bytesOut, overlays, banners, mirror };
}

describe('input-host', () => {
  it('dispatches keydown through the encoder', () => {
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(1);
    expect(bytesOut[0]![0]).toBe(0x61);
    handle.unmount();
  });

  it('progresses through T1/T2/T3 and emits commit bytes', () => {
    const { container, handle, bytesOut, overlays } = setup();
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    // Final overlay update is null (unmounted).
    expect(overlays.at(-1)).toBeNull();
    // Expect 3-byte commit for 한.
    const joined = bytesOut.reduce((acc, b) => {
      const out = new Uint8Array(acc.length + b.length);
      out.set(acc);
      out.set(b, acc.length);
      return out;
    }, new Uint8Array(0));
    const hex = Array.from(joined)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe('ed959c');
    handle.unmount();
  });

  it('suppresses keydown routed during Composing (I-7)', () => {
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    // No new bytes emitted — the keydown was absorbed by the state machine.
    expect(bytesOut.length).toBe(before);
    handle.unmount();
  });

  it('unmount removes handlers (subsequent keydown is a no-op)', () => {
    const { container, handle, bytesOut } = setup();
    handle.unmount();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(0);
  });

  it('Esc during composition cancels without forwarding the Esc byte', () => {
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
    expect(handle.state().kind).toBe('Idle');
    handle.unmount();
  });
});
