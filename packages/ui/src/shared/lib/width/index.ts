/**
 * Public entry for the width / grapheme / wrap classifier — TypeScript
 * mirror of `quanta-vt-width`.
 *
 * Consumers import from `@ui/shared/lib/width` only; internal modules
 * (`base-width-table.ts`) are implementation detail.
 *
 * Example:
 *
 * ```ts
 * import {
 *   DefaultClassifier,
 *   resolveAmbiguousPolicy,
 *   cellsForWidth,
 * } from '@ui/shared/lib/width';
 *
 * const policy = resolveAmbiguousPolicy('auto', 'macos', null); // 'narrow'
 * const classifier = new DefaultClassifier(policy);
 * const { grapheme, width } = classifier.classifyGrapheme('한');
 * // → { grapheme: '한', width: 'two' }
 * ```
 */

export type {
  AmbiguousWidthPolicy,
  CellWidth,
  Grapheme,
  OsKind,
  WrapEligibility,
} from './types.js';
export { cellsForWidth, resolveAmbiguousPolicy } from './types.js';
export { DefaultClassifier } from './classifier.js';
export type { WidthClassifier } from './classifier.js';
export { lookupOverride, OVERRIDES } from './overrides.js';
export type { Override, OverrideReason } from './overrides.js';
