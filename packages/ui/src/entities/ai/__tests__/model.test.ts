/**
 * Tests for the AI entity store. The store is intentionally stateful singleton;
 * each test `resetAll`s before running so cases do not bleed into one another.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  useAiStore,
  selectShouldShowBar,
  selectTierLabel,
  APPROVAL_HISTORY_CAP,
  type AiSuggestion,
} from '../index.js';

function makeSuggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  const base: AiSuggestion = {
    id: overrides.id ?? 's-1',
    classified: overrides.classified ?? {
      command: 'ls',
      tier: 'safe',
      modifiers: [],
      rulesetVersion: 1,
    },
    receivedAt: overrides.receivedAt ?? 1000,
  };
  if (overrides.rationale !== undefined) {
    return { ...base, rationale: overrides.rationale };
  }
  return base;
}

describe('entities/ai store', () => {
  beforeEach(() => {
    useAiStore.getState().resetAll();
  });

  it('starts empty', () => {
    const s = useAiStore.getState();
    expect(s.currentSuggestion).toBeNull();
    expect(s.pendingApproval).toBeNull();
    expect(s.approvalHistory).toHaveLength(0);
  });

  it('setSuggestion replaces the current suggestion', () => {
    const a = makeSuggestion({ id: 'a' });
    const b = makeSuggestion({ id: 'b' });
    useAiStore.getState().setSuggestion(a);
    expect(useAiStore.getState().currentSuggestion?.id).toBe('a');
    useAiStore.getState().setSuggestion(b);
    expect(useAiStore.getState().currentSuggestion?.id).toBe('b');
  });

  it('setSuggestion records a Caution suggestion as superseded when replaced without decision', () => {
    const caution = makeSuggestion({
      id: 'caution',
      classified: {
        command: 'rm file',
        tier: 'caution',
        modifiers: [],
        rulesetVersion: 1,
      },
    });
    const next = makeSuggestion({ id: 'next' });
    useAiStore.getState().setSuggestion(caution);
    useAiStore.getState().setSuggestion(next);
    const hist = useAiStore.getState().approvalHistory;
    expect(hist).toHaveLength(1);
    expect(hist.at(0)!.id).toBe('caution');
    expect(hist.at(0)!.decision).toBe('superseded');
  });

  it('setSuggestion does not record Safe suggestions as superseded', () => {
    const safe = makeSuggestion({ id: 'safe-1' });
    const next = makeSuggestion({ id: 'safe-2' });
    useAiStore.getState().setSuggestion(safe);
    useAiStore.getState().setSuggestion(next);
    expect(useAiStore.getState().approvalHistory).toHaveLength(0);
  });

  it('openApproval stores a pendingApproval without clearing the current suggestion', () => {
    const s = makeSuggestion();
    useAiStore.getState().setSuggestion(s);
    useAiStore.getState().openApproval(s);
    expect(useAiStore.getState().pendingApproval?.id).toBe(s.id);
    expect(useAiStore.getState().currentSuggestion?.id).toBe(s.id);
  });

  it('closeApproval with "approved" clears pending and current, logs history', () => {
    const s = makeSuggestion({
      id: 'x',
      classified: {
        command: 'rm x',
        tier: 'caution',
        modifiers: [],
        rulesetVersion: 1,
      },
    });
    useAiStore.getState().setSuggestion(s);
    useAiStore.getState().openApproval(s);
    useAiStore.getState().closeApproval('approved');
    const st = useAiStore.getState();
    expect(st.pendingApproval).toBeNull();
    expect(st.currentSuggestion).toBeNull();
    expect(st.approvalHistory).toHaveLength(1);
    expect(st.approvalHistory.at(0)!.decision).toBe('approved');
  });

  it('closeApproval with "rejected" also clears and logs', () => {
    const s = makeSuggestion({
      id: 'y',
      classified: {
        command: 'rm y',
        tier: 'destructive',
        modifiers: [],
        rulesetVersion: 1,
      },
    });
    useAiStore.getState().setSuggestion(s);
    useAiStore.getState().openApproval(s);
    useAiStore.getState().closeApproval('rejected');
    const st = useAiStore.getState();
    expect(st.pendingApproval).toBeNull();
    expect(st.currentSuggestion).toBeNull();
    expect(st.approvalHistory.at(0)!.decision).toBe('rejected');
  });

  it('closeApproval is a no-op when no pendingApproval exists', () => {
    useAiStore.getState().closeApproval('approved');
    expect(useAiStore.getState().approvalHistory).toHaveLength(0);
  });

  it('recordDecision appends to history without needing an open gate', () => {
    const s = makeSuggestion({
      id: 'z',
      classified: {
        command: 'mkfs',
        tier: 'blocked',
        modifiers: [],
        rulesetVersion: 1,
      },
    });
    useAiStore.getState().recordDecision(s, 'blocked');
    const hist = useAiStore.getState().approvalHistory;
    expect(hist).toHaveLength(1);
    expect(hist.at(0)!.decision).toBe('blocked');
    expect(hist.at(0)!.tier).toBe('blocked');
  });

  it('approvalHistory is capped at APPROVAL_HISTORY_CAP', () => {
    const s = makeSuggestion();
    for (let i = 0; i < APPROVAL_HISTORY_CAP + 5; i += 1) {
      useAiStore.getState().recordDecision({ ...s, id: `n-${i}` }, 'rejected');
    }
    expect(useAiStore.getState().approvalHistory).toHaveLength(APPROVAL_HISTORY_CAP);
    // Oldest entries dropped.
    expect(useAiStore.getState().approvalHistory.at(0)!.id).toBe('n-5');
  });

  it('resetAll clears everything', () => {
    useAiStore.getState().setSuggestion(makeSuggestion());
    useAiStore.getState().recordDecision(makeSuggestion(), 'rejected');
    useAiStore.getState().resetAll();
    const s = useAiStore.getState();
    expect(s.currentSuggestion).toBeNull();
    expect(s.pendingApproval).toBeNull();
    expect(s.approvalHistory).toHaveLength(0);
  });
});

describe('entities/ai selectors', () => {
  beforeEach(() => {
    useAiStore.getState().resetAll();
  });

  it('selectShouldShowBar is false without a current suggestion', () => {
    expect(selectShouldShowBar(useAiStore.getState())).toBe(false);
  });

  it('selectShouldShowBar is true when a suggestion exists and no gate is open', () => {
    useAiStore.getState().setSuggestion(makeSuggestion());
    expect(selectShouldShowBar(useAiStore.getState())).toBe(true);
  });

  it('selectShouldShowBar is false when an approval modal is open', () => {
    const s = makeSuggestion();
    useAiStore.getState().setSuggestion(s);
    useAiStore.getState().openApproval(s);
    expect(selectShouldShowBar(useAiStore.getState())).toBe(false);
  });

  it('selectTierLabel maps every tier to a human label', () => {
    expect(selectTierLabel('safe')).toBe('Safe');
    expect(selectTierLabel('caution')).toBe('Caution');
    expect(selectTierLabel('destructive')).toBe('Destructive');
    expect(selectTierLabel('blocked')).toBe('Blocked');
  });
});
