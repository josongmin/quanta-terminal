/**
 * AI entity — the UI's view of the current AI suggestion flow.
 *
 * Tracks three things:
 *   - `currentSuggestion`: the latest suggestion the provider returned. Rendered
 *     by the suggestion-bar widget above the composer. Cleared when the user
 *     accepts (Tab) or rejects (Esc) it, or when a new prompt supersedes it.
 *   - `pendingApproval`: a classified command the user is about to run but has
 *     not yet confirmed. The risk-gate feature flips this on for every
 *     Caution-or-higher suggestion and flips it off when the user confirms or
 *     cancels the gate.
 *   - `approvalHistory`: an append-only log of decisions (approved / rejected
 *     / blocked) keyed by suggestion id. The history is bounded at a
 *     session-friendly cap so the store doesn't grow unbounded in long runs.
 *
 * The tier vocabulary here exactly mirrors the `quanta-ai` Rust crate — same
 * four buckets, same labels. Any change to the tier enum in Rust needs a
 * matching edit here; the shared bridge-conformance test asserts the label
 * set is identical.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** Maximum number of decisions kept in `approvalHistory`. Trimmed FIFO. */
export const APPROVAL_HISTORY_CAP = 64;

export type RiskTier = 'safe' | 'caution' | 'destructive' | 'blocked';

/** Modifier labels emitted by the Rust classifier. Kept as a plain string type
 *  rather than a union so future additions don't require a coordinated bump
 *  across Rust + UI in the same PR. */
export type RiskModifier = string;

export interface ClassifiedCommand {
  readonly command: string;
  readonly tier: RiskTier;
  readonly modifiers: readonly RiskModifier[];
  readonly rulesetVersion: number;
}

export interface AiSuggestion {
  /** Stable id so the approval log can reference a suggestion after it's
   *  cleared from `currentSuggestion`. */
  readonly id: string;
  readonly classified: ClassifiedCommand;
  readonly rationale?: string;
  /** Wall-clock millis the suggestion was received by the UI. Used by the
   *  approval history so audit entries have a stamp. */
  readonly receivedAt: number;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'blocked' | 'superseded';

export interface ApprovalHistoryEntry {
  readonly id: string;
  readonly command: string;
  readonly tier: RiskTier;
  readonly decision: ApprovalDecision;
  readonly decidedAt: number;
}

export interface AiState {
  readonly currentSuggestion: AiSuggestion | null;
  readonly pendingApproval: AiSuggestion | null;
  readonly approvalHistory: readonly ApprovalHistoryEntry[];
}

export interface AiActions {
  /** A new suggestion arrived. Replaces `currentSuggestion` and, if the previous
   *  one was Caution-or-higher but not yet decided, records it as `superseded`
   *  in the history. */
  setSuggestion(s: AiSuggestion | null): void;

  /** The risk gate opened for a suggestion. Caller passes the already-classified
   *  payload; blocked commands never reach this path (they're rejected
   *  immediately with `recordDecision('blocked')`). */
  openApproval(s: AiSuggestion): void;

  /** The risk gate closed — either by approval or by cancel. */
  closeApproval(decision: ApprovalDecision): void;

  /** Append a raw decision to the history. Used by the gate and by the
   *  suggestion-bar's auto-reject on Esc. */
  recordDecision(suggestion: AiSuggestion, decision: ApprovalDecision): void;

  /** Test helper — clears all state. */
  resetAll(): void;
}

const INITIAL: AiState = {
  currentSuggestion: null,
  pendingApproval: null,
  approvalHistory: [],
};

export const useAiStore = create<AiState & AiActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL,
    setSuggestion: (s) =>
      set((prev) => {
        // If the previous suggestion was Caution-or-higher and never got a
        // decision, log it as superseded so the audit trail shows why it
        // disappeared. Skip when the prior suggestion already has a decision
        // in the history — otherwise a reject-then-clear flow would write
        // "rejected" followed by "superseded" for the same id.
        let nextHistory = prev.approvalHistory;
        const prior = prev.currentSuggestion;
        if (prior && prior.classified.tier !== 'safe' && !prev.pendingApproval) {
          const alreadyDecided = prev.approvalHistory.some(
            (entry) => entry.id === prior.id,
          );
          if (!alreadyDecided) {
            nextHistory = appendHistory(nextHistory, {
              id: prior.id,
              command: prior.classified.command,
              tier: prior.classified.tier,
              decision: 'superseded',
              decidedAt: Date.now(),
            });
          }
        }
        return { ...prev, currentSuggestion: s, approvalHistory: nextHistory };
      }),
    openApproval: (s) =>
      set((prev) => ({ ...prev, pendingApproval: s })),
    closeApproval: (decision) =>
      set((prev) => {
        const pending = prev.pendingApproval;
        if (!pending) return prev;
        const entry: ApprovalHistoryEntry = {
          id: pending.id,
          command: pending.classified.command,
          tier: pending.classified.tier,
          decision,
          decidedAt: Date.now(),
        };
        // On approval/rejection the current suggestion is consumed.
        const nextCurrent =
          decision === 'approved' || decision === 'rejected'
            ? null
            : prev.currentSuggestion;
        return {
          ...prev,
          pendingApproval: null,
          currentSuggestion: nextCurrent,
          approvalHistory: appendHistory(prev.approvalHistory, entry),
        };
      }),
    recordDecision: (suggestion, decision) =>
      set((prev) => ({
        ...prev,
        approvalHistory: appendHistory(prev.approvalHistory, {
          id: suggestion.id,
          command: suggestion.classified.command,
          tier: suggestion.classified.tier,
          decision,
          decidedAt: Date.now(),
        }),
      })),
    resetAll: () => set(() => ({ ...INITIAL })),
  })),
);

/**
 * Append to the ring-buffer history, trimming the oldest entry when the cap
 * is reached. FIFO is fine because older decisions are rarely inspected —
 * when they are, the user is searching for a specific command, not scrolling
 * the tail.
 */
function appendHistory(
  prev: readonly ApprovalHistoryEntry[],
  next: ApprovalHistoryEntry,
): readonly ApprovalHistoryEntry[] {
  const out = [...prev, next];
  if (out.length > APPROVAL_HISTORY_CAP) {
    return out.slice(out.length - APPROVAL_HISTORY_CAP);
  }
  return out;
}

/**
 * Pure selector — true when we should render the suggestion-bar chrome.
 * The bar is visible when a current suggestion exists AND no approval modal
 * is currently open (the modal steals focus and the bar would be redundant).
 */
export function selectShouldShowBar(state: AiState): boolean {
  return state.currentSuggestion !== null && state.pendingApproval === null;
}

/**
 * Selector — map a tier to a short label used by the bar. Separate from the
 * tier value so the UI string can evolve without touching the store.
 */
export function selectTierLabel(tier: RiskTier): string {
  switch (tier) {
    case 'safe':
      return 'Safe';
    case 'caution':
      return 'Caution';
    case 'destructive':
      return 'Destructive';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Unknown';
  }
}
