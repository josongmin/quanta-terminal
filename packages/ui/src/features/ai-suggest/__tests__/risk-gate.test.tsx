/**
 * Tests for the RiskGate modal.
 *
 * Three cases per tier: render shape, Enter behaviour, Esc behaviour. Plus
 * the typed-to-confirm flow for Destructive and the "no approve button"
 * Blocked state.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RiskGate } from '../risk-gate.js';
import type { AiSuggestion } from '../../../entities/ai/index.js';

function suggestion(
  tier: 'safe' | 'caution' | 'destructive' | 'blocked',
  command = 'rm -rf ./dist',
): AiSuggestion {
  return {
    id: `s-${tier}`,
    classified: {
      command,
      tier,
      modifiers: tier === 'safe' ? [] : ['destructive_verb'],
      rulesetVersion: 1,
    },
    rationale: 'mock',
    receivedAt: 0,
  };
}

describe('features/ai-suggest RiskGate', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing when suggestion is null', () => {
    const { container } = render(
      <RiskGate suggestion={null} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('Caution: Enter approves', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <RiskGate suggestion={suggestion('caution')} onApprove={onApprove} onReject={onReject} />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Caution: Esc rejects', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <RiskGate suggestion={suggestion('caution')} onApprove={onApprove} onReject={onReject} />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('Destructive: Enter does not approve until user types the command', () => {
    const onApprove = vi.fn();
    const s = suggestion('destructive', 'rm -rf ./dist');
    render(<RiskGate suggestion={s} onApprove={onApprove} onReject={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onApprove).not.toHaveBeenCalled();

    const input = screen.getByTestId('risk-gate-typed-input') as HTMLInputElement;
    // Wrong text — still disabled.
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'rm -rf ./dist' } });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('Destructive: approve button disabled until typed command matches', () => {
    const onApprove = vi.fn();
    const s = suggestion('destructive', 'rm x');
    render(<RiskGate suggestion={s} onApprove={onApprove} onReject={vi.fn()} />);
    const btn = screen.getByTestId('risk-gate-approve') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const input = screen.getByTestId('risk-gate-typed-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rm x' } });
    expect(btn.disabled).toBe(false);
  });

  it('Blocked: renders dismiss button, no approve', () => {
    const onReject = vi.fn();
    render(
      <RiskGate
        suggestion={suggestion('blocked', 'rm -rf /')}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    expect(screen.queryByTestId('risk-gate-approve')).toBeNull();
    const dismiss = screen.getByTestId('risk-gate-dismiss');
    fireEvent.click(dismiss);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('Blocked: Esc still dismisses', () => {
    const onReject = vi.fn();
    render(
      <RiskGate suggestion={suggestion('blocked')} onApprove={vi.fn()} onReject={onReject} />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('renders the tier badge and modifier chips', () => {
    render(
      <RiskGate suggestion={suggestion('caution')} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(screen.getByText('Caution')).toBeTruthy();
    expect(screen.getByText('destructive_verb')).toBeTruthy();
  });

  it('clicking Cancel rejects', () => {
    const onReject = vi.fn();
    render(
      <RiskGate suggestion={suggestion('caution')} onApprove={vi.fn()} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId('risk-gate-cancel'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('clicking Approve approves when allowed', () => {
    const onApprove = vi.fn();
    render(
      <RiskGate suggestion={suggestion('caution')} onApprove={onApprove} onReject={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('risk-gate-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
