/**
 * E2E — AI explain: failed block → click explain → renders explanation
 *
 * Tests the full user flow:
 *   1. Seed a block with `command: 'make build'`, `exitCode: 1`, `status: completed`.
 *   2. The BlockCard renders an <AiExplainPanel /> with an "Explain" trigger button.
 *   3. Bind a mock suggestion port where `explainError` returns a known string.
 *   4. Click the Explain button.
 *   5. Assert a loading indicator appears (panel in 'loading' state).
 *   6. Assert the explanation text renders once the promise resolves.
 *
 * The test exercises the real AiExplainPanel → useExplainBlock → SuggestionPort
 * pipeline end-to-end. The only seam is the SuggestionPort injection via
 * `bindSuggestionPort`, which is the documented test entry point.
 *
 * Event-based wiring note: AiExplainPanel listens for the global
 * `quanta:explain-block` CustomEvent (EXPLAIN_BLOCK_EVENT) as an alternative
 * trigger pathway (command palette / keyboard shortcut). Both the button-click
 * and the event-based paths are tested here.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBlockStore, type Block } from '../../entities/block/index.js';
import { BlockCard } from '../../widgets/block-card/BlockCard.js';
import {
  bindSuggestionPort,
  createMockSuggestionPort,
  resetSuggestionPortForTests,
  type SuggestionPort,
} from '../../features/ai-suggest/index.js';
import {
  EXPLAIN_BLOCK_EVENT,
  __resetAiExplainSettingsForTests,
  useAiExplainSettings,
} from '../../features/ai-explain/index.js';
import { EXPLAIN_NOT_CONFIGURED_MESSAGE } from '../../features/ai-suggest/index.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

/**
 * Seed a completed block with a non-zero exit code so the AiExplainPanel
 * considers it a "failed terminal" block worth explaining.
 */
function seedFailedBlock(
  command = 'make build',
  output = 'Error: missing dependency',
  exitCode = 1,
  cwd = '/tmp/proj',
): string {
  const id = useBlockStore.getState().createBlock(command, cwd);
  useBlockStore.getState().appendBlockOutput(id, new TextEncoder().encode(output));
  useBlockStore.getState().completeBlock(id, exitCode);
  return id;
}

/**
 * Bind a partial suggestion port for the test, filling in defaults for
 * the methods under test.
 */
function bindPort(partial: Partial<SuggestionPort>): void {
  bindSuggestionPort({
    suggest: async () => {
      throw new Error('not used');
    },
    explainError: async () => 'stub explanation',
    suggestCorrection: () => [],
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

beforeEach(() => {
  useBlockStore.getState().resetAll();
  resetSuggestionPortForTests();
  __resetAiExplainSettingsForTests();
  // Bind a default mock port (AI enabled, canned stub response).
  bindSuggestionPort(createMockSuggestionPort());
});

afterEach(() => {
  cleanup();
  useBlockStore.getState().resetAll();
  resetSuggestionPortForTests();
  __resetAiExplainSettingsForTests();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('AI explain flow (e2e)', () => {
  it('AiExplainPanel renders in idle state for a failed block', () => {
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);

    const panel = screen.getByTestId(`ai-explain-panel-${id}`);
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute('data-state')).toBe('idle');

    // "Explain" trigger button must be visible.
    expect(screen.getByTestId(`ai-explain-trigger-${id}`)).toBeInTheDocument();
  });

  it('does NOT render the panel when the block exited cleanly (exit 0)', () => {
    const id = useBlockStore.getState().createBlock('make build', '/tmp');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('does NOT render the panel while the block is still running', () => {
    const id = useBlockStore.getState().createBlock('make build', '/tmp');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('does NOT render the panel when the aiExplainEnabled setting is off', () => {
    useAiExplainSettings.getState().setEnabled(false);
    const id = seedFailedBlock();
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('clicking Explain transitions to loading state then renders explanation text', async () => {
    const explanationText = 'Build failed: missing dependency';

    // Use a controlled promise so we can assert the loading state before
    // it resolves.
    let resolveExplain!: (value: string) => void;
    const explainPromise = new Promise<string>((resolve) => {
      resolveExplain = resolve;
    });

    bindPort({
      explainError: () => explainPromise,
    });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    const trigger = screen.getByTestId(`ai-explain-trigger-${id}`);

    // Click explain — this fires the request (loading begins).
    await userEvent.click(trigger);

    // While the promise is still pending, the panel should be in loading state.
    const panel = screen.getByTestId(`ai-explain-panel-${id}`);
    expect(panel.getAttribute('data-state')).toBe('loading');

    // A loading label must be visible.
    const spinner = panel.querySelector('[aria-label]');
    expect(spinner).not.toBeNull();

    // Resolve the promise with the explanation.
    await act(async () => {
      resolveExplain(explanationText);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Panel must now be in done state with the explanation rendered.
    expect(panel.getAttribute('data-state')).toBe('done');
    const textEl = screen.getByTestId(`ai-explain-text-${id}`);
    expect(textEl).toHaveTextContent(explanationText);
  });

  it('explanation text contains the full returned string', async () => {
    const explanationText = 'Build failed: missing dependency';
    bindPort({
      explainError: async () => explanationText,
    });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    const trigger = screen.getByTestId(`ai-explain-trigger-${id}`);
    await userEvent.click(trigger);

    const textEl = await screen.findByTestId(`ai-explain-text-${id}`);
    expect(textEl).toHaveTextContent(explanationText);
  });

  it('fires explanation via the quanta:explain-block event (event-based path)', async () => {
    bindPort({ explainError: async () => 'Event-path explanation' });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(EXPLAIN_BLOCK_EVENT, { detail: { blockId: id } }),
      );
    });

    const textEl = await screen.findByTestId(`ai-explain-text-${id}`);
    expect(textEl).toHaveTextContent('Event-path explanation');
  });

  it('renders the error state with a retry button when the port throws', async () => {
    bindPort({
      explainError: async () => {
        throw new Error('network error');
      },
    });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    await userEvent.click(screen.getByTestId(`ai-explain-trigger-${id}`));

    const panel = await screen.findByTestId(`ai-explain-panel-${id}`);
    await vi.waitFor(() => {
      expect(panel.getAttribute('data-state')).toBe('error');
    });
    expect(screen.getByTestId(`ai-explain-retry-${id}`)).toBeInTheDocument();
  });

  it('panel is dismissible and disappears on dismiss click', async () => {
    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    const dismiss = screen.getByTestId(`ai-explain-dismiss-${id}`);
    await userEvent.click(dismiss);
    expect(screen.queryByTestId(`ai-explain-panel-${id}`)).toBeNull();
  });

  it('does not fire explain when event targets a different blockId', () => {
    bindPort({ explainError: vi.fn(async () => 'should not be called') });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(EXPLAIN_BLOCK_EVENT, { detail: { blockId: 'different-id' } }),
      );
    });

    // Panel stays in idle state — the event was for a different block.
    const panel = screen.getByTestId(`ai-explain-panel-${id}`);
    expect(panel.getAttribute('data-state')).toBe('idle');
  });

  it('explainError is called with the correct command and exitCode', async () => {
    // This test proves the real useExplainBlock → port wiring is live.
    // A broken hook that never calls the port would fail here because
    // explainError would have zero call count.
    const explainError = vi.fn(async () => 'Some explanation');
    bindPort({ explainError });

    const command = 'make build';
    const exitCode = 2;
    const id = useBlockStore.getState().createBlock(command, '/tmp/proj');
    useBlockStore
      .getState()
      .appendBlockOutput(id, new TextEncoder().encode('Error: missing dep'));
    useBlockStore.getState().completeBlock(id, exitCode);

    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`ai-explain-trigger-${id}`));

    await screen.findByTestId(`ai-explain-text-${id}`);

    expect(explainError).toHaveBeenCalledTimes(1);
    expect(explainError).toHaveBeenCalledWith(
      expect.objectContaining({ command, exitCode }),
    );
  });

  it('panel shows not-configured state when explainError returns EXPLAIN_NOT_CONFIGURED_MESSAGE', async () => {
    // Verifies the sentinel value path: the hook must detect the sentinel and
    // enter the "not-configured" state rather than "done".
    bindPort({ explainError: async () => EXPLAIN_NOT_CONFIGURED_MESSAGE });

    const id = seedFailedBlock('make build');
    render(<BlockCard block={currentBlock(id)} />);

    await userEvent.click(screen.getByTestId(`ai-explain-trigger-${id}`));

    const panel = await screen.findByTestId(`ai-explain-panel-${id}`);
    await vi.waitFor(() => {
      expect(panel.getAttribute('data-state')).toBe('not-configured');
    });
    // The explanation text element must NOT be present in not-configured state.
    expect(screen.queryByTestId(`ai-explain-text-${id}`)).toBeNull();
  });
});
