/**
 * Public surface for the `a11y-announce` feature — screen-reader
 * announcements of new terminal output via an `aria-live` region.
 */

export {
  useA11yAnnounceSettings,
  readStoredA11ySettings,
  resolveEffectiveAnnounceMode,
  DEFAULT_A11Y_ANNOUNCE_SETTINGS,
  A11Y_ANNOUNCE_STORAGE_KEY,
} from './settings.js';
export type {
  A11yAnnounceMode,
  A11yAnnounceSettings,
  A11yAnnounceSettingsStore,
} from './settings.js';
export {
  useOutputAnnouncer,
  extractAnnouncementLines,
  ANNOUNCE_DEBOUNCE_MS,
  ANNOUNCE_LINE_MAX_CHARS,
  ANNOUNCE_QUEUE_MAX_LINES,
} from './useOutputAnnouncer.js';
export type { UseOutputAnnouncerResult } from './useOutputAnnouncer.js';
export { LiveRegion, LIVE_REGION_CLEAR_MS } from './LiveRegion.js';
