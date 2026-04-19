/**
 * Session transcript export — render every block in a session as a single
 * markdown document with a header summarizing the session.
 *
 * Shape:
 *
 *   # Session transcript
 *
 *   - Shell: /bin/zsh
 *   - Working directory: /tmp/project
 *   - Started: 2026-04-19T12:34:56.000Z
 *   - Total blocks: 3
 *   - Total errors: 1
 *
 *   ---
 *
 *   ## `ls -la`
 *
 *   ```
 *   ...
 *   ```
 *
 *   _exit 0 · 12ms · completed_
 *
 * Block rendering reuses `exportAsMarkdown` from the block-export feature so
 * the format stays in lockstep with the per-block export affordance. Blocks
 * are walked in visual order (store `order` array).
 */

import { useBlockStore, type Block } from '../../entities/block/index.js';
import { useSessionsStore, type SessionEntity } from '../../entities/session/index.js';
// FIXME(fsd-layer-skip): transcript export composes per-block markdown via
// the block feature; both slices share the same format so duplicating the
// serializer here would drift the two surfaces apart the next time the
// block export format changes.
import { exportAsMarkdown } from '../block/export.js';
import { t } from '../../shared/i18n/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';

export interface SessionTranscriptResult {
  readonly ok: boolean;
  readonly text: string;
  readonly reason?: 'session-not-found';
}

function formatStartedAt(block: Block | undefined): string {
  if (!block) return '—';
  // ISO 8601 — stable across locales and sortable in a text file.
  try {
    return new Date(block.startedAt).toISOString();
  } catch {
    return String(block.startedAt);
  }
}

function buildHeader(session: SessionEntity, blocks: readonly Block[]): string {
  const started = formatStartedAt(blocks[0]);
  const errors = blocks.reduce((n, b) => n + (b.status === 'error' ? 1 : 0), 0);
  const lines: string[] = [];
  lines.push(`# ${t('sessionTranscript.title')}`);
  lines.push('');
  lines.push(`- ${t('sessionTranscript.header.shell')}: ${session.shell || '—'}`);
  lines.push(`- ${t('sessionTranscript.header.cwd')}: ${session.cwd || '—'}`);
  lines.push(`- ${t('sessionTranscript.header.startedAt')}: ${started}`);
  lines.push(`- ${t('sessionTranscript.header.totalBlocks')}: ${blocks.length}`);
  lines.push(`- ${t('sessionTranscript.header.totalErrors')}: ${errors}`);
  lines.push('');
  lines.push('---');
  return lines.join('\n');
}

/**
 * Render the transcript for `sessionId`. Returns a result object rather than
 * a bare string so the caller can branch on "session-not-found" and surface
 * the right feedback without re-reading the stores.
 */
export function exportSessionTranscript(sessionId: SessionId): SessionTranscriptResult {
  const sessions = useSessionsStore.getState();
  const session = sessions.entities[sessionId];
  if (!session) {
    return { ok: false, text: '', reason: 'session-not-found' };
  }
  const blockState = useBlockStore.getState();
  const blocks: Block[] = [];
  for (const id of blockState.order) {
    const b = blockState.entities[id];
    if (b && b.sessionId === sessionId) blocks.push(b);
  }

  const header = buildHeader(session, blocks);
  if (blocks.length === 0) {
    return {
      ok: true,
      text: `${header}\n\n${t('sessionTranscript.empty')}\n`,
    };
  }
  const body = blocks.map((b) => exportAsMarkdown(b)).join('\n\n');
  return {
    ok: true,
    text: `${header}\n\n${body}\n`,
  };
}
