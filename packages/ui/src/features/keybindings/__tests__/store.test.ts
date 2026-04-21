import { beforeEach, describe, expect, it } from 'vitest';

import {
  KEYBINDING_REGISTRY,
  findKeybinding,
} from '../registry.js';
import {
  __resetKeybindingsForTests,
  getEffectiveShortcuts,
  KEYBINDINGS_STORAGE_KEY,
  resolveShortcut,
  useKeybindingsStore,
} from '../store.js';

/** jsdom ships without localStorage in this project's setup — shim one. */
function installStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k) {
      data.delete(k);
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

beforeEach(() => {
  installStorage();
  __resetKeybindingsForTests();
});

describe('keybindings registry', () => {
  it('has a non-empty, unique-id registry', () => {
    expect(KEYBINDING_REGISTRY.length).toBeGreaterThan(0);
    const ids = new Set(KEYBINDING_REGISTRY.map((k) => k.id));
    expect(ids.size).toBe(KEYBINDING_REGISTRY.length);
  });

  it('findKeybinding returns defined entries and undefined for unknown ids', () => {
    const first = KEYBINDING_REGISTRY[0]!;
    expect(findKeybinding(first.id)?.id).toBe(first.id);
    expect(findKeybinding('does.not.exist')).toBeUndefined();
  });
});

describe('resolveShortcut', () => {
  it('returns the default when no override is set', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    expect(resolveShortcut(def.id, {})).toBe(def.defaultShortcut);
  });

  it('override beats default', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    expect(resolveShortcut(def.id, { [def.id]: 'mod+shift+x' })).toBe('mod+shift+x');
  });

  it('returns null for unknown ids', () => {
    expect(resolveShortcut('nope', {})).toBeNull();
  });
});

describe('useKeybindingsStore', () => {
  it('setOverride persists the new binding', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+z');
    expect(useKeybindingsStore.getState().overrides[def.id]).toBe('mod+shift+z');
    // Persistence: the next read sees the same value.
    expect(useKeybindingsStore.getState().resolveShortcut(def.id)).toBe('mod+shift+z');
  });

  it('rejects setOverride for unknown ids', () => {
    useKeybindingsStore.getState().setOverride('not.a.real.id', 'mod+z');
    expect(useKeybindingsStore.getState().overrides['not.a.real.id']).toBeUndefined();
  });

  it('clearOverride restores the default', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+z');
    useKeybindingsStore.getState().clearOverride(def.id);
    expect(useKeybindingsStore.getState().overrides[def.id]).toBeUndefined();
    expect(useKeybindingsStore.getState().resolveShortcut(def.id)).toBe(def.defaultShortcut);
  });

  it('reset wipes every override', () => {
    const [a, b] = KEYBINDING_REGISTRY;
    useKeybindingsStore.getState().setOverride(a!.id, 'mod+shift+a');
    useKeybindingsStore.getState().setOverride(b!.id, 'mod+shift+b');
    useKeybindingsStore.getState().reset();
    expect(Object.keys(useKeybindingsStore.getState().overrides)).toHaveLength(0);
  });

  it('getEffectiveShortcuts reflects override state', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+q');
    const snapshot = getEffectiveShortcuts();
    const row = snapshot.find((s) => s.id === def.id);
    expect(row?.shortcut).toBe('mod+shift+q');
  });
});

describe('cross-tab storage sync', () => {
  it('updates overrides when a storage event arrives with the keybindings key', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    expect(useKeybindingsStore.getState().overrides[def.id]).toBeUndefined();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEYBINDINGS_STORAGE_KEY,
        newValue: JSON.stringify({ [def.id]: 'mod+x' }),
      }),
    );

    expect(useKeybindingsStore.getState().overrides[def.id]).toBe('mod+x');
  });

  it('does NOT update the store when a storage event arrives with a different key', () => {
    const def = KEYBINDING_REGISTRY[0]!;
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+z');

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'some-other-key',
        newValue: JSON.stringify({ [def.id]: 'mod+x' }),
      }),
    );

    // The override set earlier should be unchanged.
    expect(useKeybindingsStore.getState().overrides[def.id]).toBe('mod+shift+z');
  });
});
