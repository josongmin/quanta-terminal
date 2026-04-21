/**
 * Public surface of features/command-correction. See `./suggest.ts` for the
 * ranking pipeline and `./levenshtein.ts` for the distance helper.
 */
export { suggestCorrection, isSingleToken, TYPO_MAP } from './suggest.js';
export type {
  Correction,
  CorrectionSource,
  CorrectionHistoryEntry,
  SuggestCorrectionArgs,
} from './suggest.js';
export { levenshtein } from './levenshtein.js';
export { CommandCorrectionHint } from './CommandCorrectionHint.js';
export type { CommandCorrectionHintProps } from './CommandCorrectionHint.js';
