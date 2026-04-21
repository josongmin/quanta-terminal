import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { KEYBINDING_REGISTRY } from '../registry.js';
import { KeybindingsSection } from '../KeybindingsSection.js';
import {
  __resetKeybindingsForTests,
  useKeybindingsStore,
} from '../store.js';

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

describe('<KeybindingsSection />', () => {
  it('renders one row per registry entry', () => {
    render(<KeybindingsSection />);
    for (const def of KEYBINDING_REGISTRY) {
      expect(screen.getByTestId(`keybinding-row-${def.id}`)).toBeInTheDocument();
    }
  });

  it('pressing Record then a combination updates the override', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    const { container } = render(<KeybindingsSection />);
    await user.click(screen.getByTestId(`keybinding-record-${def.id}`));

    // The recording overlay must appear immediately after clicking Record.
    expect(
      screen.getByTestId(`keybinding-overlay-${def.id}`),
    ).toBeInTheDocument();

    // Dispatch a synthetic keydown on the window — the recorder listens at
    // capture phase there.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'J',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Let the microtask queue drain so the promise settles and state updates.
    await act(async () => {
      await Promise.resolve();
    });

    // The store must hold the new override — this is the primary behavioral
    // assertion. A broken wiring where the keydown listener was never attached
    // would leave overrides[def.id] undefined and this would fail.
    expect(useKeybindingsStore.getState().overrides[def.id]).toBe('mod+alt+j');

    // The overlay must be dismissed once a key combination is captured.
    // If the listener is not wired, recording never resolves and the overlay
    // stays in the DOM — this assertion catches that case.
    expect(
      container.querySelector(`[data-testid="keybinding-overlay-${def.id}"]`),
    ).toBeNull();
  });

  it('Reset button restores the default and then disappears', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+z');
    render(<KeybindingsSection />);
    const resetBtn = screen.getByTestId(`keybinding-reset-${def.id}`);
    await user.click(resetBtn);
    expect(useKeybindingsStore.getState().overrides[def.id]).toBeUndefined();
    expect(screen.queryByTestId(`keybinding-reset-${def.id}`)).toBeNull();
  });

  it('shows a conflict badge when two bindings collide', () => {
    const [a, b] = KEYBINDING_REGISTRY;
    // Override `a` to match `b`'s default → conflict.
    useKeybindingsStore.getState().setOverride(a!.id, b!.defaultShortcut);
    render(<KeybindingsSection />);
    expect(screen.getByTestId(`keybinding-conflict-${a!.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`keybinding-conflict-${b!.id}`)).toBeInTheDocument();
  });

  it('no conflict badge is rendered on a clean registry', () => {
    render(<KeybindingsSection />);
    for (const def of KEYBINDING_REGISTRY) {
      expect(screen.queryByTestId(`keybinding-conflict-${def.id}`)).toBeNull();
    }
  });

  it('Escape during record resolves without changing the override', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    render(<KeybindingsSection />);
    await user.click(screen.getByTestId(`keybinding-record-${def.id}`));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useKeybindingsStore.getState().overrides[def.id]).toBeUndefined();
  });

  it('keymap subscribers resolve to the overridden shortcut', () => {
    // Effective-resolution test: the store's resolveShortcut (which is what a
    // keymap subscriber reads at mount time) reflects an override.
    const def = KEYBINDING_REGISTRY[0]!;
    expect(useKeybindingsStore.getState().resolveShortcut(def.id)).toBe(def.defaultShortcut);
    useKeybindingsStore.getState().setOverride(def.id, 'mod+shift+q');
    expect(useKeybindingsStore.getState().resolveShortcut(def.id)).toBe('mod+shift+q');
  });

  it('Reset all wipes every override', async () => {
    const user = userEvent.setup();
    const [a, b] = KEYBINDING_REGISTRY;
    useKeybindingsStore.getState().setOverride(a!.id, 'mod+shift+q');
    useKeybindingsStore.getState().setOverride(b!.id, 'mod+shift+w');
    render(<KeybindingsSection />);
    await user.click(screen.getByTestId('keybindings-reset-all'));
    expect(Object.keys(useKeybindingsStore.getState().overrides)).toHaveLength(0);
  });
});

describe('<KeybindingsSection /> + focus trap interaction', () => {
  it('record overlay announces the record-hint for screen readers', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    render(<KeybindingsSection />);
    await user.click(screen.getByTestId(`keybinding-record-${def.id}`));
    const overlay = screen.getByTestId(`keybinding-overlay-${def.id}`);
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    // Tear down by firing escape.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Ensure fireEvent helper is available (avoids unused-import flag).
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });

  it('overlay has tabIndex=-1 and receives focus when recording starts', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    render(<KeybindingsSection />);
    await user.click(screen.getByTestId(`keybinding-record-${def.id}`));
    const overlay = screen.getByTestId(`keybinding-overlay-${def.id}`);
    expect(overlay).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(overlay);
  });

  it('focus returns to the Record button after Escape cancels recording', async () => {
    const user = userEvent.setup();
    const def = KEYBINDING_REGISTRY[0]!;
    render(<KeybindingsSection />);
    const recordBtn = screen.getByTestId(`keybinding-record-${def.id}`);
    await user.click(recordBtn);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(recordBtn);
  });
});
