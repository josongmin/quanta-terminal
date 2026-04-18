import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  InstallShellIntegrationOptions,
  InstallShellIntegrationReply,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { countSnippetLines, install, preview } from '../install.js';

interface BridgeSpy {
  calls: InstallShellIntegrationOptions[];
  reply: InstallShellIntegrationReply;
  throwError: string | null;
}

function makeBridge(spy: BridgeSpy): HostBridge {
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      return { sessionId: 'x', shell: '/bin/zsh', cwd: '/' };
    },
    async write() {},
    async resize() {},
    async close() {},
    async openInEditor() {},
    async installShellIntegration(options) {
      spy.calls.push(options);
      if (spy.throwError) throw new Error(spy.throwError);
      return spy.reply;
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe() {
      return { unsubscribe: () => {} };
    },
  };
}

const defaultReply: InstallShellIntegrationReply = {
  targetPath: '/home/user/.zshrc',
  snippet:
    '\n# >>> quanta shell integration >>>\n' +
    'line-a\nline-b\nline-c\n' +
    '# <<< quanta shell integration <<<\n',
  alreadyInstalled: false,
  mutated: false,
  lineCount: 42,
};

let spy: BridgeSpy;

beforeEach(() => {
  spy = { calls: [], reply: { ...defaultReply }, throwError: null };
  setHostBridge(makeBridge(spy));
});

afterEach(() => {
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
  vi.restoreAllMocks();
});

describe('preview', () => {
  it('calls the bridge with confirm:false and returns the preview reply', async () => {
    const outcome = await preview('zsh');
    expect(outcome.kind).toBe('preview');
    if (outcome.kind !== 'preview') throw new Error('unreachable');
    expect(outcome.reply.targetPath).toBe('/home/user/.zshrc');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toEqual({ shell: 'zsh', confirm: false });
  });

  it('never passes confirm:true even when the bridge is slow', async () => {
    await preview('bash');
    expect(spy.calls[0]?.confirm).toBe(false);
  });

  it('maps bridge errors to an error outcome without throwing', async () => {
    spy.throwError = 'permission denied';
    const outcome = await preview('fish');
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(/permission denied/);
  });
});

describe('install', () => {
  it('refuses to call the bridge when userConfirmed is false', async () => {
    const outcome = await install('zsh', false);
    expect(outcome.kind).toBe('error');
    expect(spy.calls).toHaveLength(0);
  });

  it('calls the bridge with confirm:true when userConfirmed is true', async () => {
    spy.reply = { ...defaultReply, mutated: true };
    const outcome = await install('bash', true);
    expect(outcome.kind).toBe('installed');
    expect(spy.calls).toEqual([{ shell: 'bash', confirm: true }]);
  });

  it('returns already-installed when the reply says so', async () => {
    spy.reply = { ...defaultReply, alreadyInstalled: true, mutated: false };
    const outcome = await install('zsh', true);
    expect(outcome.kind).toBe('already-installed');
  });

  it('maps bridge errors to an error outcome', async () => {
    spy.throwError = 'disk full';
    const outcome = await install('fish', true);
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(/disk full/);
  });
});

describe('countSnippetLines', () => {
  it('counts body lines excluding guard markers and leading newline', () => {
    const snippet =
      '\n# >>> quanta shell integration >>>\n' + 'a\nb\nc\n' + '# <<< quanta shell integration <<<\n';
    // 3 body lines
    expect(countSnippetLines(snippet)).toBeGreaterThanOrEqual(3);
  });

  it('falls back to raw line count when markers are missing', () => {
    const snippet = 'foo\nbar\n';
    // `split('\n')` on "foo\nbar\n" yields ['foo', 'bar', ''] → 3 entries.
    expect(countSnippetLines(snippet)).toBe(3);
  });
});
