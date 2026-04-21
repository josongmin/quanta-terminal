/**
 * Cell renderer barrel (EPIC-D).
 *
 * Public surface of `@ui/shared/ui/cell-renderer` — data-model types,
 * backend interfaces, and the rAF paint loop. No Canvas2D-specific API
 * leaks through this surface (Canvas2DBackend is the reference, but
 * consumers hold the abstract `BackendContract`).
 */

export type {
  CellMetrics,
  CopyOptions,
  IMEOverlayAnchor,
  InvalidationReason,
  OverlayHandle,
  Platform,
  Rect,
  ScreenHit,
  SearchMatch,
  SearchOptions,
  SelectionAnchor,
  SelectionMode,
  SelectionState,
  Unsubscribe,
} from './types.js';
export { DEFAULT_METRICS, DEFAULT_COPY_OPTIONS } from './types.js';

export { DamageSet } from './DamageSet.js';
export type { DamageSnapshot } from './DamageSet.js';

export { MirrorSource } from './MirrorSource.js';
export type { MirrorChangeHandler } from './MirrorSource.js';

export {
  CellBuffer,
  DEFAULT_ATTRS,
  DEFAULT_COLOR,
  ATTR_BIT,
  decodeAttrs,
  encodeAttrs,
  formatSgr,
  parseSgr,
} from './CellBuffer.js';
export type {
  AttrFlags,
  Color,
  ColorKind,
  PackedCell,
  UnpackedCell,
  SearchHighlight,
} from './CellBuffer.js';

export { FontAtlas, MemoryRasterizer, DEFAULT_ATLAS_CAPACITY } from './FontAtlas.js';
export type { AtlasEntry, AtlasKey, AtlasRasterizer, FontAtlasOptions } from './FontAtlas.js';

export { HitTest } from './HitTest.js';

export { SelectionManager, normalizeSelection } from './Selection.js';
export type { SelectionListener } from './Selection.js';

export { Search, SearchError } from './Search.js';

export { Renderer } from './Renderer.js';
export type { RendererOptions } from './Renderer.js';

export {
  Canvas2DBackend,
  MemoryBackend,
} from './backend/index.js';
export type {
  BackendContract,
  BackendTextMetrics,
  MemoryBackendCall,
  MountContext,
  TextMeasurement,
} from './backend/index.js';
