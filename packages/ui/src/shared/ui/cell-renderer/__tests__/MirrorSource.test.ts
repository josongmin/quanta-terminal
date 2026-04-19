import { describe, it, expect, vi } from 'vitest';
import { MirrorSource } from '../MirrorSource.js';

describe('MirrorSource', () => {
  it('emit fires every subscriber', () => {
    const source = new MirrorSource();
    const h1 = vi.fn();
    const h2 = vi.fn();
    source.subscribe(h1);
    source.subscribe(h2);
    source.emit(new Set([1, 2]));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the handler', () => {
    const source = new MirrorSource();
    const h = vi.fn();
    const unsub = source.subscribe(h);
    unsub();
    source.emit(new Set([0]));
    expect(h).not.toHaveBeenCalled();
  });

  it('subscriberCount reflects active subscriptions', () => {
    const source = new MirrorSource();
    expect(source.subscriberCount()).toBe(0);
    const u = source.subscribe(() => undefined);
    expect(source.subscriberCount()).toBe(1);
    u();
    expect(source.subscriberCount()).toBe(0);
  });

  it('clear drops all subscribers', () => {
    const source = new MirrorSource();
    source.subscribe(() => undefined);
    source.subscribe(() => undefined);
    source.clear();
    expect(source.subscriberCount()).toBe(0);
  });
});
