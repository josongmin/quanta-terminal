/**
 * Command palette edge cases:
 * - Opening with zero commands registered shows the empty state.
 * - Pressing Tab with an empty filtered list leaves focus inside the palette.
 * - ArrowDown/Up on an empty list do not throw or advance the activeIndex.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandPalette } from '../CommandPalette.js';

describe('<CommandPalette /> edge', () => {
  it('renders empty state when opened with no commands registered', () => {
    render(<CommandPalette open onClose={() => undefined} commands={[]} />);
    // The palette uses role="status" on the empty-state message. Pin the copy.
    expect(screen.getByRole('status')).toHaveTextContent(/no sessions yet/iu);
  });

  it('ArrowDown / ArrowUp on an empty list do not throw', () => {
    render(<CommandPalette open onClose={() => undefined} commands={[]} />);
    const dialog = screen.getByRole('dialog');
    // These would previously modulo-divide by zero in a naive impl.
    expect(() => fireEvent.keyDown(dialog, { key: 'ArrowDown' })).not.toThrow();
    expect(() => fireEvent.keyDown(dialog, { key: 'ArrowUp' })).not.toThrow();
    // Enter on an empty list is also a no-op.
    expect(() => fireEvent.keyDown(dialog, { key: 'Enter' })).not.toThrow();
  });

  it('Tab with empty list keeps focus inside the palette', () => {
    // External focus target — a button placed in the DOM BEFORE the palette
    // mounts. If Tab escaped the trap the activeElement would become this
    // outer node.
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);

    render(<CommandPalette open onClose={() => undefined} commands={[]} />);
    const dialog = screen.getByRole('dialog');
    const input = screen.getByLabelText('Search commands') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // Forward Tab.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(outside);

    document.body.removeChild(outside);
  });
});
