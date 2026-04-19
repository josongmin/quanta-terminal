/**
 * Session transcript export tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { useSessionsStore } from '../../../entities/session/index.js';
import { exportSessionTranscript } from '../export-transcript.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useSessionsStore.getState().reset();
});

describe('exportSessionTranscript', () => {
  it('returns ok=false with session-not-found for unknown session ids', () => {
    const result = exportSessionTranscript('nope' as SessionId);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session-not-found');
    expect(result.text).toBe('');
  });

  it('emits a header and "no blocks" body when the session has no blocks', () => {
    useSessionsStore.getState().addSession({
      id: A,
      shell: '/bin/zsh',
      cwd: '/tmp/project',
      health: 'ready',
    });
    const result = exportSessionTranscript(A);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('# Session transcript');
    expect(result.text).toContain('Shell: /bin/zsh');
    expect(result.text).toContain('Working directory: /tmp/project');
    expect(result.text).toContain('Total blocks: 0');
    expect(result.text).toContain('No blocks');
  });

  it('renders blocks for the session in visual order', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh', cwd: '/tmp' });
    const b1 = useBlockStore.getState().createBlock('ls', '/', { sessionId: A });
    useBlockStore.getState().completeBlock(b1, 0);
    const b2 = useBlockStore.getState().createBlock('echo hi', '/', { sessionId: A });
    useBlockStore.getState().appendBlockOutput(b2, new Uint8Array([104, 105, 10]));
    useBlockStore.getState().completeBlock(b2, 0);
    const result = exportSessionTranscript(A);
    expect(result.ok).toBe(true);
    // Both commands present in that order.
    const lsIdx = result.text.indexOf('## `ls`');
    const echoIdx = result.text.indexOf('## `echo hi`');
    expect(lsIdx).toBeGreaterThan(-1);
    expect(echoIdx).toBeGreaterThan(lsIdx);
    expect(result.text).toContain('Total blocks: 2');
  });

  it('filters out blocks that belong to a different session', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh' });
    useSessionsStore.getState().addSession({ id: B, shell: '/bin/bash' });
    const bA = useBlockStore.getState().createBlock('ls-a', '/', { sessionId: A });
    useBlockStore.getState().completeBlock(bA, 0);
    const bB = useBlockStore.getState().createBlock('ls-b', '/', { sessionId: B });
    useBlockStore.getState().completeBlock(bB, 0);
    const result = exportSessionTranscript(A);
    expect(result.text).toContain('ls-a');
    expect(result.text).not.toContain('ls-b');
  });

  it('counts errored blocks in the header', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh' });
    const ok = useBlockStore.getState().createBlock('ls', '/', { sessionId: A });
    useBlockStore.getState().completeBlock(ok, 0);
    const bad = useBlockStore.getState().createBlock('nope', '/', { sessionId: A });
    useBlockStore.getState().errorBlock(bad, 'spawn EACCES');
    const result = exportSessionTranscript(A);
    expect(result.text).toContain('Total errors: 1');
  });

  it('includes the session shell and cwd in the header when present', () => {
    useSessionsStore.getState().addSession({
      id: A,
      shell: '/bin/zsh',
      cwd: '/var/data',
    });
    const result = exportSessionTranscript(A);
    expect(result.text).toContain('/bin/zsh');
    expect(result.text).toContain('/var/data');
  });
});
