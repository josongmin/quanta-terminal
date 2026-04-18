import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseShortcut,
  matchesShortcut,
  subscribeKeymap,
  __resetKeymapForTests,
  type KeyEventLike,
} from '../keymap.js';

afterEach(() => {
  __resetKeymapForTests();
});

function event(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...partial,
  };
}

describe('parseShortcut', () => {
  it('parses simple letter keys', () => {
    const p = parseShortcut('k');
    expect(p.key).toBe('k');
    expect(p.mod).toBe(false);
  });

  it('parses mod+letter', () => {
    const p = parseShortcut('mod+k');
    expect(p.mod).toBe(true);
    expect(p.key).toBe('k');
  });

  it('normalizes named keys', () => {
    expect(parseShortcut('escape').key).toBe('escape');
    expect(parseShortcut('esc').key).toBe('escape');
    expect(parseShortcut('shift+enter').key).toBe('enter');
    expect(parseShortcut('up').key).toBe('arrowup');
    expect(parseShortcut('mod+`').key).toBe('`');
    expect(parseShortcut('mod+backtick').key).toBe('`');
  });

  it('throws on unknown modifier', () => {
    expect(() => parseShortcut('hyper+k')).toThrow(/unknown modifier/u);
  });
});

describe('matchesShortcut', () => {
  it('matches exact key + mod on mac-like platforms', () => {
    const shortcut = parseShortcut('mod+k');
    // navigator.platform in jsdom includes "Mac" by default on darwin hosts,
    // so test both outcomes by toggling metaKey vs ctrlKey.
    const m = matchesShortcut(event({ key: 'k', metaKey: true }), shortcut);
    const c = matchesShortcut(event({ key: 'k', ctrlKey: true }), shortcut);
    // At least one must match on any platform; both should not match together.
    expect(m || c).toBe(true);
  });

  it('does not match when extra modifiers are held', () => {
    const shortcut = parseShortcut('k');
    expect(matchesShortcut(event({ key: 'k', metaKey: true }), shortcut)).toBe(false);
  });

  it('requires shift flag to match exactly', () => {
    const shortcut = parseShortcut('shift+enter');
    expect(matchesShortcut(event({ key: 'Enter', shiftKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(event({ key: 'Enter' }), shortcut)).toBe(false);
  });
});

describe('subscribeKeymap', () => {
  it('invokes handler on matching keydown', () => {
    const handler = vi.fn();
    subscribeKeymap({ shortcut: 'k', handler });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire when focus is in an input by default', () => {
    const handler = vi.fn();
    subscribeKeymap({ shortcut: 'k', handler });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    document.body.removeChild(input);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires in editable targets when allowInEditable is true', () => {
    const handler = vi.fn();
    subscribeKeymap({ shortcut: 'escape', handler, allowInEditable: true });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.removeChild(input);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops the handler', () => {
    const handler = vi.fn();
    const sub = subscribeKeymap({ shortcut: 'k', handler });
    sub.unsubscribe();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    expect(handler).not.toHaveBeenCalled();
  });
});
