export {
  createSession,
  closeSession,
  switchSession,
  getSessionConnection,
} from './actions.js';
export type {
  CreateSessionOptions,
  CreateSessionResult,
} from './actions.js';
export {
  getConnection,
  hasConnection,
  connectionIds,
} from './connection-map.js';
