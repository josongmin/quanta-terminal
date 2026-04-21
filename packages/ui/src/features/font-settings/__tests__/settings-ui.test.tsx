/**
 * SettingsPanel ↔ font-settings integration tests. Verifies that changing
 * family / size / ligatures in the panel updates both the store and the
 * document-root CSS custom properties that drive every consumer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsPanel } from '../../../widgets/settings-panel/SettingsPanel.js';
import { useFontSettings, resolveFamilyCss, resolveFeatureSettings } from '../store.js';

function installLocalStorage(): void {
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

function clearRootVars(): void {
  const root = document.documentElement;
  for (const v of [
    '--quanta-font-family',
    '--quanta-font-size',
    '--quanta-font-features',
    '--q-font-mono',
    '--q-font-size-term',
    '--q-font-features',
  ]) {
    root.style.removeProperty(v);
  }
}

beforeEach(() => {
  installLocalStorage();
  clearRootVars();
  useFontSettings.getState()._rehydrate();
});

afterEach(() => {
  clearRootVars();
  installLocalStorage();
});

describe('SettingsPanel <FontSection />', () => {
  it('renders the font section with family, size, and ligatures controls', () => {
    render(<SettingsPanel open onClose={() => {}} />);
    expect(screen.getByTestId('settings-font-family')).toBeInTheDocument();
    expect(screen.getByTestId('settings-font-size')).toBeInTheDocument();
    expect(screen.getByTestId('settings-font-ligatures')).toBeInTheDocument();
    expect(screen.getByTestId('settings-font-preview')).toBeInTheDocument();
  });

  it('changing the family dropdown updates the store and the CSS var', async () => {
    render(<SettingsPanel open onClose={() => {}} />);
    const select = screen.getByTestId('settings-font-family') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'jetbrains');
    expect(useFontSettings.getState().family).toBe('jetbrains');
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--quanta-font-family')).toBe(resolveFamilyCss('jetbrains'));
    expect(root.getPropertyValue('--q-font-mono')).toBe(resolveFamilyCss('jetbrains'));
  });

  it('moving the size slider updates the store and the font-size CSS var', () => {
    render(<SettingsPanel open onClose={() => {}} />);
    const slider = screen.getByTestId('settings-font-size') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '20' } });
    expect(useFontSettings.getState().size).toBe(20);
    expect(document.documentElement.style.getPropertyValue('--quanta-font-size')).toBe('20px');
    expect(document.documentElement.style.getPropertyValue('--q-font-size-term')).toBe('20px');
  });

  it('toggling the ligatures checkbox flips the feature-settings CSS var', async () => {
    render(<SettingsPanel open onClose={() => {}} />);
    const checkbox = screen.getByTestId('settings-font-ligatures') as HTMLInputElement;
    // Default on → after click, off.
    expect(checkbox.checked).toBe(true);
    await userEvent.click(checkbox);
    expect(useFontSettings.getState().ligatures).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--q-font-features')).toBe(
      resolveFeatureSettings(false),
    );
    await userEvent.click(checkbox);
    expect(useFontSettings.getState().ligatures).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--q-font-features')).toBe(
      resolveFeatureSettings(true),
    );
  });
});
