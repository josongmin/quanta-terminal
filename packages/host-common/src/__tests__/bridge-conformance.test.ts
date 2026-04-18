/**
 * Smoke-test the conformance suite itself by running it against a minimal
 * in-memory HostBridge. This guarantees that:
 *   - the suite compiles,
 *   - the suite actually executes its assertions (it is not a no-op),
 *   - any future adapter that looks like this reference bridge will pass.
 *
 * Real adapters (Tauri, VS Code) import `runHostBridgeConformance` from
 * `./bridge-conformance.js` and pass their own factory.
 */

import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SpawnSessionOptions,
  SpawnSessionResult,
  SessionId,
  Subscription,
} from '../index.js';
import { DEFAULT_CAPABILITIES } from '../index.js';
import { runHostBridgeConformance } from './bridge-conformance.js';

interface ProbeBridge extends HostBridge {
  __probe: (event: HostEvent) => void;
}

function makeInMemoryBridge(): ProbeBridge {
  const listeners = new Set<HostEventListener>();
  const bridge: ProbeBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return { sessionId: 'sess' as SessionId, shell: '/bin/sh', cwd: options.cwd ?? '/' };
    },
    async write() {},
    async resize() {},
    async close() {},
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    __probe(event: HostEvent) {
      for (const l of listeners) l(event);
    },
  };
  return bridge;
}

runHostBridgeConformance('InMemoryReferenceBridge', makeInMemoryBridge);
