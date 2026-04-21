/**
 * E2E — Command correction: typo hint → click → callback with corrected command
 *
 * Tests the full user flow:
 *   1. Seed a block with `command: 'gti'`, `exitCode: 127`, status `completed`.
 *   2. Render the full BlockCard (which includes CommandCorrectionHint).
 *   3. Assert the CommandCorrectionHint is visible with the testid.
 *   4. Click the "rerun" button.
 *   5. Assert the `onRerunWithCorrection` callback was called with `'git'`.
 *
 * Architectural note: `onRerunWithCorrection` is wired as a no-op at the
 * TerminalPage level (BlockList passes no prop → NOOP_CORRECTION_RERUN).
 * This e2e test therefore exercises the feature at the BlockCard level —
 * the same layer the feature actually operates — verifying that:
 *   - TYPO_MAP `gti → git` is live.
 *   - The hint renders for a single-token exit-127 command.
 *   - Clicking "rerun" delivers the corrected command to the caller.
 *
 * The test renders through the real BlockCard + CommandCorrectionHint +
 * suggest.ts pipeline with no mocking of those layers.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBlockStore, type Block } from '../../entities/block/index.js';
import { BlockCard } from '../../widgets/block-card/BlockCard.js';
import { TYPO_MAP } from '../../features/command-correction/suggest.js';
import * as suggestModule from '../../features/command-correction/suggest.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

/**
 * Seed a block in `completed` status with a given exit code.
 * Uses `createBlock` (not `startBlock`) to avoid arming the watchdog timer.
 */
function seedBlock(command: string, exitCode: number, cwd = '/tmp/proj'): string {
  const id = useBlockStore.getState().createBlock(command, cwd);
  useBlockStore.getState().completeBlock(id, exitCode);
  return id;
}

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  useBlockStore.getState().resetAll();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('Command correction flow (e2e)', () => {
  it('TYPO_MAP contains gti → git', () => {
    // Guard: if the map ever loses this entry the test below would fail for
    // the wrong reason. Failing here gives a clear diagnostic.
    expect(TYPO_MAP['gti']).toBe('git');
  });

  it('CommandCorrectionHint renders for gti exit-127 block', () => {
    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId(`command-correction-hint-${id}`)).toBeInTheDocument();
  });

  it('hint shows "git" as the suggested correction', () => {
    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);
    const hint = screen.getByTestId(`command-correction-hint-${id}`);
    // The <Kbd> inside the hint shows the correction.
    const kbd = hint.querySelector('kbd');
    expect(kbd?.textContent).toBe('git');
  });

  it('clicking rerun delivers corrected command "git" to onRerunWithCorrection', async () => {
    const id = seedBlock('gti', 127);
    const onRerunWithCorrection = vi.fn();

    render(
      <BlockCard
        block={currentBlock(id)}
        onRerunWithCorrection={onRerunWithCorrection}
      />,
    );

    const rerunBtn = screen.getByTestId(`command-correction-rerun-${id}`);
    await userEvent.click(rerunBtn);

    expect(onRerunWithCorrection).toHaveBeenCalledTimes(1);
    expect(onRerunWithCorrection).toHaveBeenCalledWith(id, 'git');
  });

  it('does NOT render the hint for exit 0 (successful command)', () => {
    const id = seedBlock('gti', 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render the hint for exit 1 (non-127 error)', () => {
    const id = seedBlock('gti', 1);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render the hint for multi-word command (single-token gate)', () => {
    const id = seedBlock('gti status', 127);
    render(<BlockCard block={currentBlock(id)} />);
    // suggestCorrection gates on isSingleToken — multi-word commands are rejected.
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('hint is dismissible and disappears after clicking dismiss', async () => {
    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);

    expect(screen.getByTestId(`command-correction-hint-${id}`)).toBeInTheDocument();

    const dismissBtn = screen.getByTestId(`command-correction-dismiss-${id}`);
    await userEvent.click(dismissBtn);

    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('data-confidence attribute is "high" for a TYPO_MAP hit', () => {
    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);
    const hint = screen.getByTestId(`command-correction-hint-${id}`);
    expect(hint.getAttribute('data-confidence')).toBe('high');
    expect(hint.getAttribute('data-source')).toBe('typo');
  });

  it('correction also fires for other TYPO_MAP entries (sl → ls)', () => {
    const id = seedBlock('sl', 127);
    const onRerunWithCorrection = vi.fn();
    render(
      <BlockCard block={currentBlock(id)} onRerunWithCorrection={onRerunWithCorrection} />,
    );
    const hint = screen.getByTestId(`command-correction-hint-${id}`);
    const kbd = hint.querySelector('kbd');
    expect(kbd?.textContent).toBe('ls');

    act(() => {
      screen.getByTestId(`command-correction-rerun-${id}`).click();
    });
    expect(onRerunWithCorrection).toHaveBeenCalledWith(id, 'ls');
  });

  it('suggestCorrection is actually called internally by CommandCorrectionHint with correct args', () => {
    // Spy on the real suggestCorrection to confirm CommandCorrectionHint calls
    // it — not just that a hint element happens to appear in the DOM.
    const spy = vi.spyOn(suggestModule, 'suggestCorrection');

    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);

    // The hint should appear (the real function is still called through the spy).
    expect(screen.getByTestId(`command-correction-hint-${id}`)).toBeInTheDocument();

    // Confirm suggestCorrection was invoked and received the typed command.
    expect(spy).toHaveBeenCalled();
    const callArgs = spy.mock.calls[0]![0];
    expect(callArgs.command).toBe('gti');

    spy.mockRestore();
  });

  it('hint is absent when suggestCorrection returns null (verifies hint is gated on function return)', () => {
    // Mock suggestCorrection to return null so we prove the hint disappears
    // when the function decides there is nothing to suggest.  A broken
    // implementation that bypassed suggestCorrection and rendered the hint
    // unconditionally would fail this test.
    const spy = vi.spyOn(suggestModule, 'suggestCorrection').mockReturnValue(null);

    const id = seedBlock('gti', 127);
    render(<BlockCard block={currentBlock(id)} />);

    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();

    spy.mockRestore();
  });

  it('TYPO_MAP is consulted: non-map exit-127 word without history yields no hint', () => {
    // "zzzcmd" is not in TYPO_MAP and there is no history → suggestCorrection
    // returns null → no hint should appear.  This verifies the TYPO_MAP lookup
    // is the deciding factor for known corrections, not just exit code 127.
    const id = seedBlock('zzzcmd', 127);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });
});
