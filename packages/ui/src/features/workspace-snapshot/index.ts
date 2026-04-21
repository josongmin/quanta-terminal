export {
  AUTO_SNAPSHOT_ID,
  AUTO_SNAPSHOT_NAME,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  isAutoSnapshot,
} from './model.js';
export type {
  WorkspaceSnapshot,
  SnapSession,
  SerializedPaneTree,
  SerializedPaneNode,
} from './model.js';

export { captureSnapshot, restoreSnapshot } from './serialize.js';
export type {
  CaptureSnapshotInput,
  RestoreSnapshotDeps,
  RestoreSnapshotOptions,
} from './serialize.js';

export {
  createIdbSnapshotAdapter,
  SNAPSHOT_DB_NAME,
  SNAPSHOT_DB_VERSION,
  SNAPSHOT_DB_SCHEMA,
  SNAPSHOT_STORE_NAME,
} from './adapter.js';
export type { SnapshotAdapter } from './adapter.js';

export {
  useWorkspaceSnapshotStore,
  setSnapshotAdapter,
  saveNamedSnapshot,
  saveAutoSnapshot,
  autoRestoreIfPresent,
  bindAutoCapture,
  splitSnapshots,
  AUTO_RESTORE_STORAGE_KEY,
} from './store.js';
export type {
  WorkspaceSnapshotState,
  WorkspaceSnapshotActions,
  AutoCaptureBinding,
} from './store.js';
