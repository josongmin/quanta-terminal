/**
 * BlockCard — secret redaction integration.
 *
 * Feeds a block with output bytes containing a GitHub PAT, then verifies:
 *   - The detector banner appears with a count.
 *   - The rendered output is masked (original token is not present).
 *   - Clicking "Show secrets" reveals the original token.
 *   - Toggling the master redact setting OFF disables the banner and
 *     restores the original output, without the user touching the per-block
 *     reveal toggle.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import {
  useSecretRedactSettings,
  useSecretRevealStore,
} from '../../../features/secret-detect/index.js';
import { BlockCard } from '../BlockCard.js';
import type { Block } from '../../../entities/block/index.js';

const GH_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useSecretRevealStore.getState().clear();
  useSecretRedactSettings.getState().setEnabled(true);
});

afterEach(() => {
  useSecretRevealStore.getState().clear();
  useSecretRedactSettings.getState().setEnabled(true);
});

describe('BlockCard — secret redaction', () => {
  it('renders the secret banner and masks the token in the body', () => {
    const id = useBlockStore.getState().createBlock('echo $TOKEN', '/');
    useBlockStore.getState().appendBlockOutput(id, bytes(`token=${GH_TOKEN}\n`));
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);

    // Banner present — reports the count.
    expect(screen.getByTestId(`block-secret-banner-${id}`)).toBeInTheDocument();
    // The raw token must NOT appear in the rendered body.
    expect(screen.getByTestId('block-output')).not.toHaveTextContent(GH_TOKEN);
  });

  it('toggling "Show secrets" reveals the original token for just this block', () => {
    const id = useBlockStore.getState().createBlock('echo $TOKEN', '/');
    useBlockStore.getState().appendBlockOutput(id, bytes(`token=${GH_TOKEN}\n`));
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);

    const toggle = screen.getByTestId(`block-secret-toggle-${id}`);
    act(() => {
      fireEvent.click(toggle);
    });

    // After reveal, the original token appears in the output body.
    expect(screen.getByTestId('block-output')).toHaveTextContent(GH_TOKEN);
    // Per-block flag is set.
    expect(useSecretRevealStore.getState().revealed.has(id)).toBe(true);
  });

  it('when the master redact setting is OFF, the banner is not shown and the token is visible', () => {
    useSecretRedactSettings.getState().setEnabled(false);

    const id = useBlockStore.getState().createBlock('echo $TOKEN', '/');
    useBlockStore.getState().appendBlockOutput(id, bytes(`token=${GH_TOKEN}\n`));
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);

    expect(screen.queryByTestId(`block-secret-banner-${id}`)).toBeNull();
    expect(screen.getByTestId('block-output')).toHaveTextContent(GH_TOKEN);
  });

  it('does not render the banner for a clean output block', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, bytes('hello world\n'));
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);

    expect(screen.queryByTestId(`block-secret-banner-${id}`)).toBeNull();
    expect(screen.getByTestId('block-output')).toHaveTextContent('hello world');
  });
});
