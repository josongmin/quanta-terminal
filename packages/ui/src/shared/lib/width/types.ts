/**
 * Width / grapheme domain types — TypeScript mirror of `quanta-vt-width`.
 *
 * Pure value types. No IO, no DOM, no allocation beyond the string primitives
 * inherent to the runtime. This module compiles even if the classifier is
 * stripped out — analogous to `crates/quanta-vt-width/src/domain/mod.rs`.
 *
 * Serialization form matches the Rust side's serde `rename_all = "lowercase"`
 * and `rename_all = "snake_case"` contracts. A `CellWidth` that travels over
 * the wire as `"zero" | "one" | "two"` from the engine round-trips into the
 * same string union on this side.
 */

/**
 * Number of terminal cells occupied by a single grapheme cluster.
 *
 * - `'zero'` — combining marks, VS15 applied to emoji-presentation, ZWJ
 *   continuation parts.
 * - `'one'` — ASCII, Latin-1, most Latin Extended, DEC line-drawing,
 *   half-width kana.
 * - `'two'` — CJK ideographs, emoji presentation, full-width forms, VS16
 *   applied to text-presentation.
 */
export type CellWidth = 'zero' | 'one' | 'two';

/**
 * A single grapheme cluster. Alias of `string` — the TS runtime has no
 * SmallString analogue, so we keep the grapheme as the exact UTF-8 string
 * the classifier accepted. Invariant: `Grapheme.length > 0` represents a
 * single cluster produced by `Intl.Segmenter(…, { granularity: 'grapheme' })`.
 */
export type Grapheme = string;

/**
 * Policy for East-Asian Ambiguous width characters (UAX #11).
 *
 * Ambiguous code points (e.g. `U+2018 LEFT SINGLE QUOTATION MARK`) can be
 * rendered 1 or 2 cells depending on locale. One wrong choice and every
 * column after the character is misaligned, so this is a per-session setting,
 * resolved once at session boot.
 *
 * Mirrors Rust `AmbiguousWidthPolicy { Narrow, Wide, Auto }` with serde
 * `rename_all = "lowercase"`.
 */
export type AmbiguousWidthPolicy = 'narrow' | 'wide' | 'auto';

/**
 * Host OS family. Used by `resolveAmbiguousPolicy` to pick a sensible
 * default for East-Asian Ambiguous characters.
 *
 * Mirrors Rust `OsKind` with serde `rename_all = "snake_case"`.
 */
export type OsKind = 'macos' | 'windows' | 'linux' | 'other_unix';

/**
 * Whether a grapheme fits on the current row, must wrap, or is a
 * no-break hint (zero-width attachment).
 *
 * Mirrors Rust `WrapEligibility` with serde `rename_all = "snake_case"`.
 *
 * - `'fits'` — the grapheme fits in `col..col + width <= cols`.
 * - `'must_wrap'` — the grapheme is 2 cells and `col + 2 > cols`. A 2-cell
 *   character must NEVER be split across rows; it is flushed whole to the
 *   next row and the last column on the previous row is left blank.
 * - `'no_break_hint'` — the grapheme is zero-width (combining mark / ZWJ
 *   continuation) and attaches to the preceding cluster; caller should
 *   apply it without advancing the column cursor.
 */
export type WrapEligibility = 'fits' | 'must_wrap' | 'no_break_hint';

/**
 * Number of cells for a `CellWidth`. Handy for column arithmetic.
 *
 * Mirrors Rust `CellWidth::cells`.
 */
export function cellsForWidth(w: CellWidth): 0 | 1 | 2 {
  switch (w) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'two':
      return 2;
  }
}

/**
 * True if `lang` looks CJK. Case-insensitive substring match on `ko`, `ja`,
 * `zh`. Covers `ko_KR.UTF-8`, `ja_JP`, `zh_CN.GB18030`, `zh-Hant`, etc.
 *
 * Mirrors Rust `AmbiguousWidthPolicy::lang_is_cjk`.
 */
function langIsCjk(lang: string | null | undefined): boolean {
  if (lang == null) return false;
  const lower = lang.toLowerCase();
  return lower.includes('ko') || lower.includes('ja') || lower.includes('zh');
}

/**
 * Resolve an ambiguous-width policy against the host OS and `$LANG`.
 *
 * Total and deterministic — given the same `(policy, os, lang)` tuple it
 * always returns the same value. Already-resolved `'narrow'` / `'wide'`
 * pass through unchanged so callers can invoke unconditionally.
 *
 * Rules (mirrors Rust `AmbiguousWidthPolicy::resolve`):
 *
 * - `(MacOs, _)` → `'narrow'`
 * - `(Windows, _)` → `'narrow'`
 * - `(Linux | OtherUnix, lang)` where lang contains `ko` / `ja` / `zh` → `'wide'`
 * - `(Linux | OtherUnix, _)` otherwise → `'narrow'`
 */
export function resolveAmbiguousPolicy(
  policy: AmbiguousWidthPolicy,
  os: OsKind,
  lang: string | null | undefined,
): 'narrow' | 'wide' {
  if (policy === 'narrow' || policy === 'wide') return policy;
  // policy === 'auto'
  switch (os) {
    case 'macos':
    case 'windows':
      return 'narrow';
    case 'linux':
    case 'other_unix':
      return langIsCjk(lang) ? 'wide' : 'narrow';
  }
}
