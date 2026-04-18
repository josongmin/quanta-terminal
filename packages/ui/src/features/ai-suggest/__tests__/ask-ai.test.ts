/**
 * Tests for the "Ask AI" palette command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiStore } from '../../../entities/ai/index.js';
import {
  createAskAiCommand,
  extendPaletteWithAskAi,
  ASK_AI_COMMAND_ID,
} from '../ask-ai.js';
import {
  bindSuggestionPort,
  createMockSuggestionPort,
  resetSuggestionPortForTests,
} from '../provider-port.js';

describe('features/ai-suggest ask-ai command', () => {
  beforeEach(() => {
    useAiStore.getState().resetAll();
    bindSuggestionPort(createMockSuggestionPort());
  });
  afterEach(() => {
    resetSuggestionPortForTests();
  });

  it('has a stable id, label, and keyboard hint', () => {
    const cmd = createAskAiCommand();
    expect(cmd.id).toBe(ASK_AI_COMMAND_ID);
    expect(cmd.id).toBe('ai.ask');
    expect(cmd.label).toBe('Ask AI for a command');
    expect(cmd.section).toBe('actions');
    expect(cmd.hint).toEqual(['⌘', 'I']);
  });

  it('run() asks for a prompt and stores the resulting suggestion', async () => {
    const cmd = createAskAiCommand({ ask: () => 'show me status' });
    cmd.run?.();
    // Provider call is async; wait for the microtask queue to drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const s = useAiStore.getState().currentSuggestion;
    expect(s).not.toBeNull();
    expect(s?.classified.command).toBe('git status');
  });

  it('run() is a no-op on empty prompts', async () => {
    const cmd = createAskAiCommand({ ask: () => '' });
    cmd.run?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAiStore.getState().currentSuggestion).toBeNull();
  });

  it('run() is a no-op when ask returns null', async () => {
    const cmd = createAskAiCommand({ ask: () => null });
    cmd.run?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAiStore.getState().currentSuggestion).toBeNull();
  });

  it('extendPaletteWithAskAi appends to an existing catalogue', () => {
    const base = [{ id: 'a' }, { id: 'b' }] as const;
    const extended = extendPaletteWithAskAi(base);
    expect(extended).toHaveLength(3);
    expect(extended.at(-1)?.id).toBe(ASK_AI_COMMAND_ID);
  });

  it('swallows provider errors so the palette keeps working', async () => {
    bindSuggestionPort({
      suggest: async () => {
        throw new Error('boom');
      },
    });
    const cmd = createAskAiCommand({ ask: () => 'anything' });
    // Must not throw.
    expect(() => cmd.run?.()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAiStore.getState().currentSuggestion).toBeNull();
  });

  it('calls onSuggested after the suggestion lands', async () => {
    const onSuggested = vi.fn();
    const cmd = createAskAiCommand({ ask: () => 'status', onSuggested });
    cmd.run?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSuggested).toHaveBeenCalledTimes(1);
  });
});
