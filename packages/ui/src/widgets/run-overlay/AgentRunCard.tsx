/**
 * AgentRunCard — renders one agent-type Run as a peer to BlockCard.
 *
 * Relationship to BlockOverlay / BlockCard
 * ----------------------------------------
 * P1-C's `BlockOverlay` renders shell Runs (command blocks). Agent Runs
 * are shaped differently — no command text, distinct metadata (tool,
 * args, source, confidence) — so this widget sits as a peer rather than
 * trying to shoehorn the tool-call view into BlockCard.
 *
 * When a future generalized `RunCard` arrives (after W2-D), the two
 * should compose through a shared `RunCardShell` primitive that switches
 * on `run.type`. For now we keep them separate so P2-E can land without
 * breaking the shell card's hot path.
 *
 * Chrome differentiation
 * ----------------------
 *   - Purple accent stripe + icon (vs the shell card's green exit dot).
 *   - Tool name shown as a pill; args summarized as a single-line JSON
 *     preview.
 *   - Live streaming dot while `status === 'running'`; static status tag
 *     otherwise.
 *
 * Input
 * -----
 * Only `runId` is passed in. The card re-subscribes to the runs-store so
 * it picks up streaming chunks without prop drilling and so tests can
 * mutate the store directly without a re-render from the caller.
 *
 * Flag gating
 * -----------
 * The card itself renders unconditionally when given a valid id — the
 * `agentRunSurface` flag gates whether it gets *mounted* upstream. Keeping
 * the flag check outside this file lets tests render the card in isolation
 * without flipping the global flag first.
 */

import { memo, useMemo } from 'react';
import { useRun } from '../../features/agent-runs/index.js';
import styles from './agent-run-card.module.css';

export interface AgentRunCardProps {
  readonly runId: string;
}

const TEXT_DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

function AgentRunCardImpl({ runId }: AgentRunCardProps) {
  const run = useRun(runId);

  // All hooks declared unconditionally so React's hook order stays stable
  // regardless of whether `run` is present / the Run is actually an agent.
  const decoded = useMemo(() => {
    if (!run) return '';
    if (run.outputChunks.length === 0) return '';
    // Concat small enough since synthesized mock output is bounded;
    // real runners can stream larger volumes — future work will switch
    // to the same incremental AnsiParser pipeline BlockCard uses.
    let total = 0;
    for (const c of run.outputChunks) total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of run.outputChunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return TEXT_DECODER.decode(buf);
  }, [run]);

  const argsSummary = useMemo(() => {
    if (!run) return '{}';
    const args = (run.metadata.args ?? {}) as Record<string, unknown>;
    return safeStringify(args);
  }, [run]);

  if (!run) return null;
  if (run.type !== 'agent') return null;

  const tool = String(run.metadata.tool ?? 'unknown');
  const source = String(run.metadata.source ?? 'ai');
  const confidence = typeof run.metadata.confidence === 'number'
    ? run.metadata.confidence
    : null;

  return (
    <article
      className={styles.card}
      data-testid={`agent-run-card-${run.id}`}
      data-type="agent"
      data-status={run.status}
      aria-label={`Agent run: ${tool}`}
    >
      <span className={styles.stripe} aria-hidden />
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden>
          <SparkleIcon />
        </span>
        <span className={styles.toolName} data-testid={`agent-run-tool-${run.id}`}>
          {tool}
        </span>
        <span className={styles.source} aria-label={`Source ${source}`}>
          {source}
        </span>
        {confidence !== null && (
          <span className={styles.confidence} aria-label="Confidence">
            conf {(confidence * 100).toFixed(0)}%
          </span>
        )}
        {run.status === 'running' ? (
          <span
            className={styles.statusTag}
            data-status={run.status}
            data-testid={`agent-run-streaming-${run.id}`}
          >
            <span className={styles.streamingDot} aria-hidden />
            streaming
          </span>
        ) : (
          <span
            className={styles.statusTag}
            data-status={run.status}
            data-testid={`agent-run-status-${run.id}`}
          >
            {run.status}
          </span>
        )}
      </div>
      <div className={styles.argsRow} data-testid={`agent-run-args-${run.id}`}>
        {argsSummary}
      </div>
      {decoded.length > 0 && (
        <pre className={styles.body} data-testid={`agent-run-body-${run.id}`}>
          {decoded}
        </pre>
      )}
    </article>
  );
}

function safeStringify(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '{}';
  try {
    return JSON.stringify(args);
  } catch {
    return '{ <unserializable> }';
  }
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 1.5l1.2 3.1L11.5 6 8.2 7.2 7 10.5 5.8 7.2 2.5 6l3.3-1.4L7 1.5z"
        fill="currentColor"
      />
      <path
        d="M11 10l.5 1.3L12.8 12l-1.3.5L11 14l-.5-1.5L9 12l1.5-.7L11 10z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

export const AgentRunCard = memo(AgentRunCardImpl, (prev, next) => {
  return prev.runId === next.runId;
});

AgentRunCard.displayName = 'AgentRunCard';
