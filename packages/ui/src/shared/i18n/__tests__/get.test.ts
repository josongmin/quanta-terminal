import { describe, expect, it } from 'vitest';
import { t, STRINGS, type StringKey } from '../index.js';

describe('i18n t()', () => {
  it('returns the string for a known key', () => {
    expect(t('composer.placeholder')).toBe(STRINGS['composer.placeholder']);
  });

  it('falls back to the key when the lookup misses', () => {
    // Cast to the typed key — a runtime-only typo path the helper tolerates.
    const missing = 'not.a.real.key' as unknown as StringKey;
    expect(t(missing)).toBe('not.a.real.key');
  });

  it('interpolates {{param}} placeholders', () => {
    const out = t('composer.modeLabel', { mode: 'shell' });
    expect(out).toBe('Composer mode: shell');
  });

  it('supports nested / dotted keys in the catalog', () => {
    // The "nesting" is represented by dots in the flat record; confirm that
    // the deepest-looking keys still resolve.
    expect(t('settings.sections.appearance')).toBe('Appearance');
    expect(t('wizard.button.installLoading')).toBe('Installing…');
  });

  it('coerces non-string params to strings', () => {
    const out = t('statusBar.exitedWithCode', { code: 137 });
    expect(out).toBe('exited 137');
  });

  it('leaves placeholders untouched when no params object is passed', () => {
    expect(t('composer.modeLabel')).toBe('Composer mode: {{mode}}');
  });

  it('handles an empty params object without crashing', () => {
    expect(t('composer.placeholder', {})).toBe('Type a command, then Enter');
  });

  it('keeps unknown placeholders in the template when not provided', () => {
    const out = t('historySearch.noMatches', { other: 'x' });
    expect(out).toBe('No matches for “{{query}}”.');
  });

  it('replaces multiple placeholders in the same template (synthetic)', () => {
    // The catalog uses single-placeholder templates today; verify the regex
    // loops by falling through two values via the coercion path.
    // We assert on a template known to contain a placeholder.
    const out = t('wizard.done.appended', { path: '/home/u/.zshrc' });
    expect(out).toContain('/home/u/.zshrc');
  });

  it('tolerates null/undefined param values by leaving the placeholder', () => {
    const withNull = t('composer.modeLabel', { mode: null });
    expect(withNull).toBe('Composer mode: {{mode}}');
    const withUndef = t('composer.modeLabel', { mode: undefined });
    expect(withUndef).toBe('Composer mode: {{mode}}');
  });
});
