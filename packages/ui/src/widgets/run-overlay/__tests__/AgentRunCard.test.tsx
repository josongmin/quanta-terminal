/**
 * AgentRunCard — rendering, tool-name display, streaming indicator.
 *
 * Strategy: hydrate a single agent Run into the `useRunsStore` and
 * render the card with its id. We exercise the store path end-to-end
 * so streaming appends reflect in the body on re-render.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRunCard } from '../AgentRunCard.js';
import { useRunsStore } from '../../../features/agent-runs/index.js';

function seedAgentRun(
  overrides: Partial<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    source: 'ai' | 'user';
    confidence: number;
  }> = {},
): string {
  const id = overrides.id ?? 'run-a1';
  // Wrap in act() so zustand's synchronous set() during the before-render
  // seeding doesn't trip React's "state update outside act" warning when
  // the subsequent render re-subscribes.
  act(() => {
    useRunsStore.getState().createRun({
      id,
      type: 'agent',
      command: null,
      startedAt: 1_700_000_000_000,
      metadata: {
        tool: overrides.tool ?? 'git_log',
        args: overrides.args ?? { n: 5 },
        source: overrides.source ?? 'ai',
        confidence: overrides.confidence ?? 0.9,
      },
    });
  });
  return id;
}

beforeEach(() => {
  useRunsStore.getState().resetAll();
});

afterEach(() => {
  useRunsStore.getState().resetAll();
});

describe('<AgentRunCard />', () => {
  it('renders nothing when the run is absent', () => {
    const { container } = render(<AgentRunCard runId="missing" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a card with data-type="agent" and data-status="running"', () => {
    const id = seedAgentRun();
    render(<AgentRunCard runId={id} />);
    const card = screen.getByTestId(`agent-run-card-${id}`);
    expect(card).toHaveAttribute('data-type', 'agent');
    expect(card).toHaveAttribute('data-status', 'running');
  });

  it('displays the tool name as a pill', () => {
    const id = seedAgentRun({ tool: 'shell_exec' });
    render(<AgentRunCard runId={id} />);
    const pill = screen.getByTestId(`agent-run-tool-${id}`);
    expect(pill).toHaveTextContent('shell_exec');
  });

  it('renders an arg summary row with stringified args', () => {
    const id = seedAgentRun({ args: { path: '/tmp', depth: 2 } });
    render(<AgentRunCard runId={id} />);
    const row = screen.getByTestId(`agent-run-args-${id}`);
    expect(row).toHaveTextContent('"path":"/tmp"');
    expect(row).toHaveTextContent('"depth":2');
  });

  it('renders "{}" for empty args without throwing', () => {
    const id = seedAgentRun({ args: {} });
    render(<AgentRunCard runId={id} />);
    const row = screen.getByTestId(`agent-run-args-${id}`);
    expect(row).toHaveTextContent('{}');
  });

  it('shows a streaming indicator while status === "running"', () => {
    const id = seedAgentRun();
    render(<AgentRunCard runId={id} />);
    expect(screen.getByTestId(`agent-run-streaming-${id}`)).toBeInTheDocument();
  });

  it('replaces the streaming indicator with a status tag on completion', async () => {
    const id = seedAgentRun();
    const { rerender } = render(<AgentRunCard runId={id} />);
    await act(async () => {
      useRunsStore.getState().completeRun(id, 0);
    });
    rerender(<AgentRunCard runId={id} />);
    expect(screen.queryByTestId(`agent-run-streaming-${id}`)).toBeNull();
    const status = screen.getByTestId(`agent-run-status-${id}`);
    expect(status).toHaveAttribute('data-status', 'completed');
  });

  it('streams decoded output bytes into the body on append', async () => {
    const id = seedAgentRun();
    const { rerender } = render(<AgentRunCard runId={id} />);
    await act(async () => {
      useRunsStore
        .getState()
        .appendRunOutput(id, new TextEncoder().encode('Running tool: git_log\n'));
    });
    rerender(<AgentRunCard runId={id} />);
    expect(screen.getByTestId(`agent-run-body-${id}`)).toHaveTextContent('Running tool: git_log');
  });

  it('does not render a body pre when there is no output yet', () => {
    const id = seedAgentRun();
    render(<AgentRunCard runId={id} />);
    expect(screen.queryByTestId(`agent-run-body-${id}`)).toBeNull();
  });

  it('ignores non-agent runs', () => {
    // Synthesize a shell-typed run directly via the store to guarantee the
    // card filters it out rather than happily rendering a command block.
    act(() => {
      useRunsStore.getState().createRun({
        id: 'shell-1',
        type: 'shell',
        command: 'ls',
        startedAt: 1,
        metadata: {},
      });
    });
    const { container } = render(<AgentRunCard runId="shell-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('displays the source tag ("ai" / "user") for provenance', () => {
    const id = seedAgentRun({ source: 'user' });
    render(<AgentRunCard runId={id} />);
    expect(screen.getByLabelText('Source user')).toBeInTheDocument();
  });

  it('renders the confidence percentage when metadata.confidence is numeric', () => {
    const id = seedAgentRun({ confidence: 0.87 });
    render(<AgentRunCard runId={id} />);
    expect(screen.getByLabelText('Confidence')).toHaveTextContent('87%');
  });

  it('transitions to canceled status when cancelRun fires mid-stream', async () => {
    const id = seedAgentRun();
    const { rerender } = render(<AgentRunCard runId={id} />);
    await act(async () => {
      useRunsStore.getState().cancelRun(id);
    });
    rerender(<AgentRunCard runId={id} />);
    const card = screen.getByTestId(`agent-run-card-${id}`);
    expect(card).toHaveAttribute('data-status', 'canceled');
    expect(screen.getByTestId(`agent-run-status-${id}`)).toHaveAttribute('data-status', 'canceled');
  });
});
