export { notify, ensureNotificationPermission } from './notify.js';
export type { NotifyOptions, NotifyResult } from './notify.js';
export {
  useNotifySettings,
  readStoredSettings,
  NOTIFY_STORAGE_KEY,
  DEFAULT_LONG_RUN_THRESHOLD_MS,
  MIN_LONG_RUN_THRESHOLD_MS,
  MAX_LONG_RUN_THRESHOLD_MS,
} from './settings.js';
export type { NotifySettings, NotifySettingsStore } from './settings.js';
export { installNotificationDetector, buildCompletionMessage } from './detector.js';
export type { DetectorHandle, InstallOptions } from './detector.js';
