export {
  useFontSettings,
  getFontSettings,
  subscribeFontChange,
  applyFontSettingsToDocument,
  readStoredFontSettings,
  resolveFamilyCss,
  resolveFeatureSettings,
  clampFontSize,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_DEFAULT,
  FONT_SETTINGS_STORAGE_KEY,
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_LIGATURES,
} from './store.js';
export type {
  FontSettings,
  FontSettingsStore,
  FontFamilyOption,
} from './store.js';
