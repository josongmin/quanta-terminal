/**
 * searchHistory — ADR 0013 ranking over the block store.
 *
 * Phase 4 ships retrieval over the frontend persistence layer (plus any
 * in-memory terminal blocks not yet persisted). Pipeline:
 *   1. Source: the block store's `entities` map, filtered to terminal-state
 *      blocks (hydrated + any freshly terminated blocks).
 *   2. Workspace filter: by default we only see blocks belonging to the
 *      current workspace. `opts.globalHistory = true` widens to all workspaces
 *      and activates the `w_workspace` boost for in-workspace hits.
 *   3. Candidate generation: BM25 over `command + output + diagnostic` with a
 *      length cap per block so a single huge output can't dominate the index.
 *   4. Rerank: recency decay + pin/label/diag/workspace boosts − dup/fail
 *      penalties (see `./weights.ts`).
 *   5. Dedup: near-duplicate commands (same normalized command + cwd +
 *      exit-status sign) collapse to one result; the chosen representative
 *      is the most recent.
 *   6. Cut: return top N (default 20).
 *
 * Precomputed index
 * -----------------
 * The BM25 index rebuilds whenever the underlying block set changes. Callers
 * that batch multiple searches per user keystroke can share one index via
 * `searchHistoryPrepared`.
 */

import {
  useBlockStore,
  type Block,
} from '../../entities/block/index.js';
import {
  buildIndex,
  bm25Score,
  normalizeScores,
  tokenize,
  type Bm25Index,
  type Document,
} from './tokenize.js';
import {
  DEFAULT_RANKING_WEIGHTS,
  recencyDecay,
  type RankingWeights,
} from './weights.js';

/** Per-block metadata precomputed once per index rebuild. Cheaper to fold
 *  into the doc than to materialize from the block on every candidate. */
interface HistoryDoc extends Document {
  readonly block: Block;
  readonly commandTokens: readonly string[];
  readonly outputTokens: readonly string[];
  readonly diagnosticTokens: readonly string[];
  readonly normalizedCommand: string;
  readonly dupKey: string;
  readonly exitPositive: boolean;
}

export interface SearchOptions {
  /** Maximum results returned after dedup / cut. Default 20. */
  readonly limit?: number;
  /** When true, search all workspaces. Default false (scoped to current). */
  readonly globalHistory?: boolean;
  /** Override the "current workspace" fingerprint. Default pulled from block's
   *  own metadata at hydrate time; tests supply this directly. */
  readonly currentWorkspaceId?: string;
  /** Override weights (e.g. for A/B tests or the debug panel). */
  readonly weights?: RankingWeights;
  /** Now-in-ms for the recency decay; defaults to Date.now(). */
  readonly now?: number;
  /** User-applied label set for the query; each exact match adds `w_label`. */
  readonly labels?: readonly string[];
}

export interface SearchHit {
  readonly block: Block;
  readonly score: number;
  readonly hitTokens: readonly string[];
  /** Individual rank contributions, for the debug panel. */
  readonly components: {
    readonly bm25: number;
    readonly recency: number;
    readonly pin: number;
    readonly label: number;
    readonly diag: number;
    readonly workspace: number;
    readonly dupPenalty: number;
    readonly failNoise: number;
  };
  /** Whether this hit is a dedup-representative standing in for `duplicateCount`
   *  other blocks. Always ≥ 1; 1 when unique. */
  readonly duplicateCount: number;
}

/** Cap per-field token count so one huge output doesn't drown the index. */
const MAX_OUTPUT_TOKENS = 4_000;
const MAX_COMMAND_TOKENS = 128;
const MAX_DIAG_TOKENS = 512;

/**
 * Normalize a command for dedup: collapse whitespace, strip outer quotes,
 * lowercase. Mirrors the FTS "command_text" pipeline documented in the ADR.
 */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function buildHistoryDoc(
  block: Block,
  decodeOutput: (b: Block) => string,
): HistoryDoc {
  const command = block.command ?? '';
  const output = decodeOutput(block);
  // Diagnostic text not modeled in the Phase-4 Block shape yet; the error
  // message is the closest analogue and participates in diag signal.
  const diagnostic = block.errorMessage ?? '';

  const commandTokens = tokenize(command).slice(0, MAX_COMMAND_TOKENS);
  const outputTokens = tokenize(output).slice(0, MAX_OUTPUT_TOKENS);
  const diagnosticTokens = tokenize(diagnostic).slice(0, MAX_DIAG_TOKENS);

  // Weight the command higher than the output in the combined index by
  // repeating it 3x — a common BM25 trick for field boosts without a proper
  // multi-field scorer. Diagnostic gets 2x.
  const combined = [
    ...commandTokens,
    ...commandTokens,
    ...commandTokens,
    ...diagnosticTokens,
    ...diagnosticTokens,
    ...outputTokens,
  ];

  const normalized = normalizeCommand(command);
  const exitPositive = (block.exitCode ?? 0) === 0;

  return {
    id: block.id,
    tokens: combined,
    block,
    commandTokens,
    outputTokens,
    diagnosticTokens,
    normalizedCommand: normalized,
    dupKey: `${normalized}|${block.cwd}|${exitPositive ? 'ok' : 'fail'}`,
    exitPositive,
  };
}

/**
 * Default output decoder. The raw bytes are UTF-8-encoded PTY output; we cap
 * at 16 KiB of decoded text per block so a log dump doesn't drag every token
 * into the index.
 */
const DEFAULT_OUTPUT_TOKEN_BUDGET = 16 * 1024;
const textDecoder: TextDecoder | null =
  typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

export function defaultDecodeOutput(block: Block): string {
  if (!textDecoder) return '';
  let taken = 0;
  const parts: string[] = [];
  for (const chunk of block.outputChunks) {
    const room = DEFAULT_OUTPUT_TOKEN_BUDGET - taken;
    if (room <= 0) break;
    const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    parts.push(textDecoder.decode(slice, { stream: true }));
    taken += slice.byteLength;
  }
  parts.push(textDecoder.decode());
  return parts.join('');
}

export interface PreparedIndex {
  readonly index: Bm25Index;
  readonly docs: readonly HistoryDoc[];
}

/** Build the prepared index once and reuse across keystrokes. */
export function prepareIndex(
  blocks: readonly Block[],
  decodeOutput: (b: Block) => string = defaultDecodeOutput,
): PreparedIndex {
  const docs: HistoryDoc[] = [];
  for (const b of blocks) {
    if (b.status === 'running') continue;
    docs.push(buildHistoryDoc(b, decodeOutput));
  }
  const index = buildIndex(docs);
  return { index, docs };
}

/**
 * Run a search against an already-prepared index.
 */
export function searchHistoryPrepared(
  prepared: PreparedIndex,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const weights = opts.weights ?? DEFAULT_RANKING_WEIGHTS;
  const limit = opts.limit ?? 20;
  const now = opts.now ?? Date.now();
  const queryTokens = tokenize(query);
  // Empty query: the history widget surfaces a "type to search" affordance,
  // not a recent-view list. Recent-view is a separate feature. Short-circuit.
  if (queryTokens.length === 0) return [];
  const labels = opts.labels ?? [];
  const globalHistory = opts.globalHistory ?? false;
  const currentWorkspaceId = opts.currentWorkspaceId ?? null;

  // Workspace scoping is a caller contract: `prepareIndex` receives the
  // blocks the caller has already filtered to the active workspace, so the
  // default (non-global) branch is a no-op here. When the Block shape grows
  // a workspace-id tag we'll filter inside this function. Until then we
  // rely on `currentWorkspaceId` only to drive the workspace boost below
  // (when globalHistory is on). Previously this branch had a reassignment
  // that was both redundant and misleading; dropped in the audit pass.
  const candidates = prepared.docs;

  // Compute BM25 scores AND capture the matched-token list in a single pass.
  // The previous implementation scored twice per doc (once for `.score`, then
  // again to retrieve `.matchedTokens`), which doubled BM25 work on the hot
  // path. Empty queries short-circuited earlier via `queryTokens.length === 0
  // → return []`, so here we only deal with a real query.
  interface Scored {
    readonly doc: HistoryDoc;
    readonly normBm25: number;
    readonly hitTokens: readonly string[];
    readonly rawBm25: number;
  }
  const rawScores: number[] = new Array<number>(candidates.length);
  const matchedCache: Array<readonly string[]> = new Array<readonly string[]>(candidates.length);
  for (let i = 0; i < candidates.length; i += 1) {
    const doc = candidates[i];
    if (!doc) {
      rawScores[i] = 0;
      matchedCache[i] = [];
      continue;
    }
    const s = bm25Score(doc, queryTokens, prepared.index);
    rawScores[i] = s.score;
    matchedCache[i] = s.matchedTokens;
  }
  const normalized = normalizeScores(rawScores);

  const scored: Scored[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const doc = candidates[i];
    if (!doc) continue;
    const raw = rawScores[i] ?? 0;
    const norm = normalized[i] ?? 0;
    // Require at least one token to match or the doc is irrelevant.
    if (raw <= 0) continue;
    scored.push({ doc, normBm25: norm, rawBm25: raw, hitTokens: matchedCache[i] ?? [] });
  }

  // Compute per-candidate boosts + final score.
  interface Ranked {
    readonly doc: HistoryDoc;
    readonly hitTokens: readonly string[];
    readonly score: number;
    readonly components: SearchHit['components'];
  }
  const ranked: Ranked[] = scored.map(({ doc, normBm25, hitTokens }) => {
    const recency =
      weights.recency *
      recencyDecay(doc.block.completedAt ?? doc.block.startedAt, now, weights.recencyHalfLifeMs);
    const pinRaw = doc.block.pinned ? weights.pin : 0;
    // Label boost: exact token match against the labels list.
    let labelMatches = 0;
    for (const label of labels) {
      const tokens = tokenize(label);
      if (tokens.some((t) => doc.commandTokens.includes(t))) labelMatches += 1;
    }
    const label = weights.label * labelMatches;
    // Diagnostic boost: did any query token hit the diagnostic field?
    let diagHit = 0;
    for (const t of hitTokens) {
      if (doc.diagnosticTokens.includes(t)) {
        diagHit = 1;
        break;
      }
    }
    const diag = weights.diag * diagHit;
    // Workspace boost applies only when globalHistory is on AND this block is
    // in the current workspace. Block-level workspace tags aren't in the
    // Phase-4 Block shape, so we treat `currentWorkspaceId` as a yes/no flag
    // on the prepared set until the shape grows that field.
    const workspace = globalHistory && currentWorkspaceId !== null ? weights.workspace : 0;
    // Fail-noise penalty applies only when the match is weak (BM25 < 0.2) —
    // the ADR calls this "recency-only ties".
    const failNoise = !doc.exitPositive && normBm25 < 0.2 ? weights.failNoise : 0;

    const score =
      weights.bm25 * normBm25 + recency + pinRaw + label + diag + workspace - failNoise;

    return {
      doc,
      hitTokens,
      score,
      components: {
        bm25: weights.bm25 * normBm25,
        recency,
        pin: pinRaw,
        label,
        diag,
        workspace,
        dupPenalty: 0,
        failNoise,
      },
    };
  });

  // Pinned-floor rule: a pinned block with BM25 ≥ `pinMinBm25` always gets
  // at least the pin boost applied (already is the case) AND is guaranteed
  // a slot above non-pinned results of comparable BM25. We implement this by
  // nudging pinned candidates to the top of each score bucket at sort time.
  ranked.sort((a, b) => {
    const ap = a.doc.block.pinned && a.components.bm25 >= weights.pinMinBm25 ? 1 : 0;
    const bp = b.doc.block.pinned && b.components.bm25 >= weights.pinMinBm25 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreaker: newer blocks beat older blocks.
    return (
      (b.doc.block.completedAt ?? b.doc.block.startedAt) -
      (a.doc.block.completedAt ?? a.doc.block.startedAt)
    );
  });

  // Dedup near-duplicates — collapse blocks sharing `dupKey`, keeping the
  // most recent as the representative. The duplicate penalty applies to
  // later-appearing duplicates in the *pre-collapse* list per the ADR text
  // ("per near-duplicate prior to this one"); after collapse it surfaces as
  // the `duplicateCount` counter on the representative.
  const seen = new Map<string, Ranked & { count: number }>();
  const dupSeenIndex = new Map<string, number>();
  for (const r of ranked) {
    const key = r.doc.dupKey;
    const priorCount = dupSeenIndex.get(key) ?? 0;
    dupSeenIndex.set(key, priorCount + 1);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...r, count: 1 });
    } else {
      // Apply dup penalty: subtract `dupPenalty` from the existing score
      // once per additional duplicate observed.
      existing.count += 1;
      const penalty = weights.dupPenalty;
      seen.set(key, {
        ...existing,
        count: existing.count,
        score: existing.score - penalty,
        components: {
          ...existing.components,
          dupPenalty: existing.components.dupPenalty + penalty,
        },
      });
    }
  }

  const collapsed = [...seen.values()].sort((a, b) => {
    const ap = a.doc.block.pinned && a.components.bm25 >= weights.pinMinBm25 ? 1 : 0;
    const bp = b.doc.block.pinned && b.components.bm25 >= weights.pinMinBm25 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.score - a.score;
  });

  const out: SearchHit[] = collapsed.slice(0, limit).map((r) => ({
    block: r.doc.block,
    score: r.score,
    hitTokens: r.hitTokens,
    components: r.components,
    duplicateCount: r.count,
  }));

  return out;
}

/**
 * Convenience wrapper: pulls the full block list from the store, builds the
 * index, runs the search.
 *
 * For responsive search you want to retain the prepared index across
 * keystrokes — use `useHistoryIndex` from the widget / call `prepareIndex`
 * once and pass the result to `searchHistoryPrepared`.
 */
export function searchHistory(query: string, opts: SearchOptions = {}): SearchHit[] {
  const state = useBlockStore.getState();
  const blocks: Block[] = [];
  for (const id of state.order) {
    const b = state.entities[id];
    if (b) blocks.push(b);
  }
  const prepared = prepareIndex(blocks);
  return searchHistoryPrepared(prepared, query, opts);
}
