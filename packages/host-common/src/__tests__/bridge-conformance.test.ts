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
    async cancelBlock() {
      // Reference bridge: cancel is a no-op. The real Tauri bridge routes
      // through the sidecar; adapters that can't cancel (this one, the
      // mock bridge) resolve silently to keep the Stop button idempotent.
    },
    async openInEditor() {},
    async installShellIntegration(options) {
      return {
        targetPath: `/tmp/mock-${options.shell}rc`,
        snippet: '# >>> quanta shell integration >>>\n# <<< quanta shell integration <<<\n',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest(options) {
      return {
        id: `mock-${options.prompt}`,
        command: 'ls -la',
        tier: 'safe',
        modifiers: ['allowlist_match'],
        rulesetVersion: 1,
        rationale: 'Mocked: list files.',
      };
    },
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
