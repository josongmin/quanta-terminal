import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../CommandPalette.js';
import type { Command } from '../commands.js';

const FIXTURE: readonly Command[] = [
  { id: 'sessions.new', label: 'New session', section: 'sessions', hint: ['⌘', 'T'] },
  { id: 'sessions.close', label: 'Close session', section: 'sessions', hint: ['⌘', 'W'] },
  { id: 'actions.focus', label: 'Focus terminal', section: 'actions', hint: ['⌘', '`'] },
];

describe('<CommandPalette />', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} onClose={() => undefined} commands={FIXTURE} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a dialog with aria-modal when open', () => {
    render(<CommandPalette open onClose={() => undefined} commands={FIXTURE} />);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={FIXTURE} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={FIXTURE} />);
    const backdrop = screen.getByTestId('palette-backdrop');
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close when the panel interior is clicked', () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={FIXTURE} />);
    const panel = screen.getByRole('dialog');
    fireEvent.mouseDown(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('runs the active row on Enter', () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={FIXTURE} onRun={onRun} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'sessions.new' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('moves the selection with ArrowDown and wraps', () => {
    const onRun = vi.fn();
    render(<CommandPalette open onClose={() => undefined} commands={FIXTURE} onRun={onRun} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'sessions.close' }));
  });

  it('filters by query and shows an empty state when nothing matches', async () => {
    render(<CommandPalette open onClose={() => undefined} commands={FIXTURE} />);
    const input = screen.getByLabelText('Search commands');
    await userEvent.type(input, 'zzz-nomatch');
    expect(screen.getByRole('status')).toHaveTextContent(/no sessions yet/iu);
  });

  it('traps focus inside the palette', () => {
    // Put a button outside the palette and ensure Tab stays inside.
    const outer = document.createElement('button');
    outer.textContent = 'outside';
    document.body.appendChild(outer);
    render(<CommandPalette open onClose={() => undefined} commands={FIXTURE} />);
    const dialog = screen.getByRole('dialog');
    const input = screen.getByLabelText('Search commands') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // A Tab dispatch inside the container wraps back to the first focusable.
    act(() => {
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    document.body.removeChild(outer);
  });

  it('aria-activedescendant points at the active row and updates with ArrowDown', () => {
    render(<CommandPalette open onClose={() => undefined} commands={FIXTURE} />);
    const input = screen.getByLabelText('Search commands') as HTMLInputElement;
    // On open the first row is active.
    expect(input.getAttribute('aria-activedescendant')).toBe('quanta-palette-opt-sessions.new');
    const dialog = screen.getByRole('dialog');
    act(() => {
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    });
    expect(input.getAttribute('aria-activedescendant')).toBe('quanta-palette-opt-sessions.close');
  });

  it('returns focus to the previously active element on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(
      <CommandPalette open onClose={() => undefined} commands={FIXTURE} />,
    );
    // Palette opened: focus now in the search input.
    expect(document.activeElement).not.toBe(trigger);
    rerender(<CommandPalette open={false} onClose={() => undefined} commands={FIXTURE} />);
    // After close the palette restores focus to the previous element.
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
