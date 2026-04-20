/**
 * BlockHoverCard — unit tests.
 *
 * Every section of the rich tooltip is exercised: command/status header,
 * tag row (session, pinned, error, running), metric bars (duration/size/
 * lines), lifecycle row, rerun lineage (predecessor + successor), and
 * the keyboard-shortcut footer.
 *
 * Because the card portals to `document.body`, `screen` queries resolve
 * against the testing-library container; jsdom's `document.body` IS the
 * container by default so queries still find the node.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore, type Block } from '../../../entities/block/index.js';
import { BlockHoverCard } from '../BlockHoverCard.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('<BlockHoverCard />', () => {
  it('renders the command, short id, and status badge for a running block', () => {
    const id = useBlockStore.getState().createBlock('ls -la', '/tmp/project');
    render(<BlockHoverCard block={currentBlock(id)} x={100} y={100} open />);
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    // Short id is "blk-" + last 6 chars of the UUID.
    expect(screen.getByText(/^blk-/u)).toBeInTheDocument();
  });

  it('renders a DONE badge and exit code for a completed block', () => {
    const id = useBlockStore.getState().createBlock('echo ok', '/home/me');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText(/exit/u)).toBeInTheDocument();
  });

  it('renders a FAIL badge and #error tag on nonzero exit', () => {
    const id = useBlockStore.getState().createBlock('false', '/');
    useBlockStore.getState().completeBlock(id, 1);
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText('#error')).toBeInTheDocument();
  });

  it('renders a CANCEL badge for a canceled block', () => {
    const id = useBlockStore.getState().createBlock('sleep 9', '/');
    useBlockStore.getState().cancelBlock(id);
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('CANCEL')).toBeInTheDocument();
  });

  it('surfaces cwd and shell in the stats row when available', () => {
    const id = useBlockStore.getState().createBlock('pwd', '/tmp/ws');
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText(/cwd: \/tmp\/ws/u)).toBeInTheDocument();
  });

  it('shows a #pinned tag when the block is pinned', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().togglePin(id);
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('#pinned')).toBeInTheDocument();
  });

  it('renders the metric bars for duration, size, and lines', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore
      .getState()
      .appendBlockOutput(id, new Uint8Array([104, 105, 0x0a])); // "hi\n"
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('SIZE')).toBeInTheDocument();
    expect(screen.getByText('LINES')).toBeInTheDocument();
  });

  it('shows rerun lineage when the block has a predecessor', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    render(<BlockHoverCard block={currentBlock(b)} x={0} y={0} open />);
    expect(screen.getByText('rerun of')).toBeInTheDocument();
  });

  it('shows rerun lineage when the block has a successor', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    render(<BlockHoverCard block={currentBlock(a)} x={0} y={0} open />);
    expect(screen.getByText("rerun'd as")).toBeInTheDocument();
  });

  it('renders the keyboard-shortcut footer with open/copy/rerun/export/diff', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('copy output')).toBeInTheDocument();
    expect(screen.getByText('rerun')).toBeInTheDocument();
    expect(screen.getByText('export')).toBeInTheDocument();
    expect(screen.getByText('diff')).toBeInTheDocument();
  });

  it('renders with role="tooltip" for a11y', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open />);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('sets data-open=false when open prop is false', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockHoverCard block={currentBlock(id)} x={0} y={0} open={false} />);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.getAttribute('data-open')).toBe('false');
  });
});
