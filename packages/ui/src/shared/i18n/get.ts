/**
 * `t(key, params?)` — the single lookup helper for user-visible copy.
 *
 * Behaviour:
 *   - `key` is a path into `STRINGS` (the keyof-typed record). A missing key
 *     falls back to returning the key itself so a typo is visible in the UI
 *     instead of crashing or rendering `undefined`.
 *   - `{{param}}` placeholders in the template are replaced by
 *     `params[param]`. Missing params are left as-is so the next render (with
 *     hydrated data) can retry. Non-string values are coerced via `String()`.
 *   - Empty / omitted `params` is a no-op; the template is returned verbatim.
 *
 * The helper is sync and synchronous-safe: the string table is a module
 * constant. When locales land, `t()` will read from a resolved table chosen
 * by a `setLocale()` call; the signature stays the same.
 */

import { STRINGS, type StringKey } from './strings.js';

export type InterpolationParams = Record<string, string | number | boolean | null | undefined>;

const PLACEHOLDER_RE = /\{\{\s*([^}\s]+)\s*\}\}/gu;

export function t(key: StringKey, params?: InterpolationParams): string {
  const template = STRINGS[key];
  // Missing-key fallback: `STRINGS` is typed but runtime callers may pass a
  // string cast — return the key itself so the UI makes the mistake visible.
  if (typeof template !== 'string') {
    return typeof key === 'string' ? key : String(key);
  }
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    if (value === null || value === undefined) return match;
    return typeof value === 'string' ? value : String(value);
  });
}

/** Convenience — expose the typed key so callers can do `satisfies` checks. */
export type { StringKey };
