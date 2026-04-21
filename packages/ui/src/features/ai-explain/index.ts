/**
 * Public surface of `features/ai-explain` — the inline "Explain this
 * error" affordance on failed blocks.
 *
 * The feature is composed of:
 *   - `useExplainBlock` — state machine + port call.
 *   - `<AiExplainPanel />` — card rendered below the BlockCard.
 *   - `useExplainShortcut` — focused-card `E` keyboard shortcut.
 *   - palette entry — "Explain last failure".
 *   - `useAiExplainSettings` — persisted master toggle.
 */

export {
  useExplainBlock,
  projectOutputForExplain,
  MAX_OUTPUT_BYTES,
} from './useExplainBlock.js';
export type {
  ExplainState,
  UseExplainBlockOptions,
  UseExplainBlockResult,
} from './useExplainBlock.js';

export {
  AiExplainPanel,
  EXPLAIN_BLOCK_EVENT,
} from './AiExplainPanel.js';
export type {
  AiExplainPanelProps,
  ExplainBlockEventDetail,
} from './AiExplainPanel.js';

export {
  useAiExplainSettings,
  readStoredAiExplainSettings,
  AI_EXPLAIN_STORAGE_KEY,
  __resetAiExplainSettingsForTests,
} from './settings.js';
export type {
  AiExplainSettings,
  AiExplainSettingsStore,
} from './settings.js';

export {
  renderSimpleMarkdown,
  splitFencedSegments,
} from './markdown.js';
export type {
  MarkdownSegment,
  ProseSegment,
  CodeSegment,
} from './markdown.js';

export {
  createExplainLastFailureCommand,
  extendPaletteWithExplainLastFailure,
  pickLastFailedBlockId,
  EXPLAIN_LAST_FAILURE_COMMAND_ID,
} from './palette.js';
export type { ExplainLastFailureCommand } from './palette.js';

export { useExplainShortcut } from './useExplainShortcut.js';
export type { UseExplainShortcutOptions } from './useExplainShortcut.js';
