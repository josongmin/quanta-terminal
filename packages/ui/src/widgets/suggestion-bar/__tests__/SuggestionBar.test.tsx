/**
 * Tests for the SuggestionBar widget.
 *
 * The widget reads from the `entities/ai` store and renders only when a
 * suggestion is present. Tab/Esc bindings are exercised with synthetic
 * keydown events; we pass a `keyboardTarget` so the test does not mutate
 * the global `window` listener set.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SuggestionBar } from '../SuggestionBar.js';
import { useAiStore, type AiSuggestion } from '../../../entities/ai/index.js';

function sample(
  tier: 'safe' | 'caution' | 'destructive' | 'blocked' = 'safe',
): AiSuggestion {
  return {
    id: `s-${tier}`,
    classified: {
      command: tier === 'blocked' ? 'rm -rf /' : 'ls -la',
      tier,
      modifiers: tier === 'safe' ? [] : ['destructive_verb'],
      rulesetVersion: 1,
    },
    rationale: 'list files',
    receivedAt: 0,
  };
}

describe('widgets/suggestion-bar SuggestionBar', () => {
  beforeEach(() => {
    useAiStore.getState().resetAll();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing when no suggestion is active', () => {
    const { container } = render(<SuggestionBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the command, rationale and tier badge', () => {
    useAiStore.getState().setSuggestion(sample('safe'));
    render(<SuggestionBar />);
    expect(screen.getByTestId('suggestion-bar')).toBeTruthy();
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.getByText('list files')).toBeTruthy();
    expect(screen.getByText('Safe')).toBeTruthy();
  });

  it('is hidden when a pending approval is open', () => {
    const s = sample('caution');
    useAiStore.getState().setSuggestion(s);
    useAiStore.getState().openApproval(s);
    render(<SuggestionBar />);
    expect(screen.queryByTestId('suggestion-bar')).toBeNull();
  });

  it('Accept button on Safe calls onAccept and clears the store', () => {
    const onAccept = vi.fn();
    useAiStore.getState().setSuggestion(sample('safe'));
    render(<SuggestionBar onAccept={onAccept} />);
    fireEvent.click(screen.getByTestId('suggestion-bar-accept'));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(useAiStore.getState().currentSuggestion).toBeNull();
    expect(useAiStore.getState().approvalHistory.at(-1)?.decision).toBe('approved');
  });

  it('Accept button on Caution opens the risk gate', () => {
    const onAccept = vi.fn();
    useAiStore.getState().setSuggestion(sample('caution'));
    render(<SuggestionBar onAccept={onAccept} />);
    fireEvent.click(screen.getByTestId('suggestion-bar-accept'));
    expect(onAccept).not.toHaveBeenCalled();
    expect(useAiStore.getState().pendingApproval?.id).toBe('s-caution');
  });

  it('Reject button calls onReject and clears the store', () => {
    const onReject = vi.fn();
    useAiStore.getState().setSuggestion(sample('caution'));
    render(<SuggestionBar onReject={onReject} />);
    fireEvent.click(screen.getByTestId('suggestion-bar-reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(useAiStore.getState().currentSuggestion).toBeNull();
    expect(useAiStore.getState().approvalHistory.at(-1)?.decision).toBe('rejected');
  });

  it('Tab accepts via the keyboard target', () => {
    const onAccept = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    useAiStore.getState().setSuggestion(sample('safe'));
    render(<SuggestionBar onAccept={onAccept} keyboardTarget={target} />);
    fireEvent.keyDown(target, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('Esc rejects via the keyboard target', () => {
    const onReject = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    useAiStore.getState().setSuggestion(sample('safe'));
    render(<SuggestionBar onReject={onReject} keyboardTarget={target} />);
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('Shift+Tab is not consumed (keeps native tab cycling)', () => {
    const onAccept = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    useAiStore.getState().setSuggestion(sample('safe'));
    render(<SuggestionBar onAccept={onAccept} keyboardTarget={target} />);
    fireEvent.keyDown(target, { key: 'Tab', shiftKey: true });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('shows a modifier count when modifiers are present', () => {
    useAiStore.getState().setSuggestion(sample('caution'));
    render(<SuggestionBar />);
    expect(screen.getByText('1 modifier')).toBeTruthy();
  });
});
