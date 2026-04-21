/**
 * Integration tests for <AiExplainPanel /> — renders through <BlockCard />
 * so the tests mirror how the panel lives in the production tree.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBlockStore, type Block } from '../../../entities/block/index.js';
import { BlockCard } from '../../../widgets/block-card/BlockCard.js';
import {
  bindSuggestionPort,
  createMockSuggestionPort,
  resetSuggestionPortForTests,
  EXPLAIN_NOT_CONFIGURED_MESSAGE,
  type SuggestionPort,
} from '../../ai-suggest/index.js';
import {
  EXPLAIN_BLOCK_EVENT,
  __resetAiExplainSettingsForTests,
  useAiExplainSettings,
} from '../index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

function seedFailedBlock(command = 'ls missing', output = 'No such file', exit = 1): string {
  const id = useBlockStore.getState().createBlock(command, '/tmp');
  useBlockStore
    .getState()
    .appendBlockOutput(id, new TextEncoder().encode(output));
  useBlockStore.getState().completeBlock(id, exit);
  return id;
}

function bindPort(partial: Partial<SuggestionPort>): void {
  bindSuggestionPort({
    suggest: async () => {
      throw new Error('not used');
    },
    explainError: async () => 'stub',
    suggestCorrection: () => [],
    ...partial,
  });
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  resetSuggestionPortForTests();
  __resetAiExplainSettingsForTests();
  bindSuggestionPort(createMockSuggestionPort());
});

describe('<AiExplainPanel />', () => {
  it('renders the idle "Explain" button on a failed block', () => {
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId(`ai-explain-panel-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ai-explain-trigger-${id}`)).toBeInTheDocument();
  });

  it('does NOT render when exitCode is 0', () => {
    const id = useBlockStore.getState().createBlock('ls', '/tmp');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('does NOT render while the block is still running', () => {
    const id = useBlockStore.getState().createBlock('ls', '/tmp');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('does NOT render when the aiExplainEnabled setting is off', () => {
    useAiExplainSettings.getState().setEnabled(false);
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('renders the explanation text after clicking Explain', async () => {
    bindPort({
      explainError: async () =>
        'The command `ls` **failed** because the path is missing.',
    });
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    const trigger = screen.getByTestId(`ai-explain-trigger-${id}`);
    await userEvent.click(trigger);
    const text = await screen.findByTestId(`ai-explain-text-${id}`);
    expect(text).toHaveTextContent(/ls/u);
    // Bold span should be rendered.
    expect(text.querySelector('strong')?.textContent).toBe('failed');
    // Inline code span should be rendered.
    expect(text.querySelector('code')?.textContent).toBe('ls');
  });

  it('renders the not-configured branch when the sentinel is returned', async () => {
    bindPort({
      explainError: async () => EXPLAIN_NOT_CONFIGURED_MESSAGE,
    });
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`ai-explain-trigger-${id}`));
    const panel = await screen.findByTestId(`ai-explain-panel-${id}`);
    expect(panel.getAttribute('data-state')).toBe('not-configured');
    expect(panel).toHaveTextContent(/AI provider not configured/i);
  });

  it('renders the error branch with a Retry button when the port throws', async () => {
    bindPort({
      explainError: async () => {
        throw new Error('network');
      },
    });
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`ai-explain-trigger-${id}`));
    const panel = await screen.findByTestId(`ai-explain-panel-${id}`);
    await vi.waitFor(() =>
      expect(panel.getAttribute('data-state')).toBe('error'),
    );
    expect(screen.getByTestId(`ai-explain-retry-${id}`)).toBeInTheDocument();
  });

  it('hides the panel after the dismiss button is clicked', async () => {
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    const dismiss = screen.getByTestId(`ai-explain-dismiss-${id}`);
    await userEvent.click(dismiss);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('fires explain() when the quanta:explain-block event targets this panel', async () => {
    bindPort({ explainError: async () => 'here is why' });
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(EXPLAIN_BLOCK_EVENT, { detail: { blockId: id } }),
      );
    });
    const text = await screen.findByTestId(`ai-explain-text-${id}`);
    expect(text).toHaveTextContent(/here is why/u);
  });

  it('fires explain() via the focused-block E keyboard shortcut', async () => {
    bindPort({ explainError: async () => 'keyboard path explanation' });
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    // Focus the card header so the shortcut's focus-gate passes.
    const header = screen
      .getByTestId(`block-card-${id}`)
      .querySelector('[role="button"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    header!.focus();
    await userEvent.keyboard('e');
    const text = await screen.findByTestId(`ai-explain-text-${id}`);
    expect(text).toHaveTextContent(/keyboard path/u);
  });
});
