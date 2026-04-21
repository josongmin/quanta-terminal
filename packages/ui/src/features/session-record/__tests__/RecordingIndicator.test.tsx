/**
 * RecordingIndicator — component tests.
 *
 * Covers:
 *   - hidden when idle;
 *   - renders REC + timer when recording;
 *   - timer advances with wall-clock passage.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionRecordStore } from '../../../entities/session-record/index.js';
import { RecordingIndicator } from '../RecordingIndicator.js';

describe('<RecordingIndicator />', () => {
  beforeEach(() => {
    useSessionRecordStore.getState().reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    useSessionRecordStore.getState().reset();
    vi.useRealTimers();
  });

  it('renders nothing when idle', () => {
    render(<RecordingIndicator />);
    expect(screen.queryByTestId('recording-indicator')).toBeNull();
  });

  it('renders REC + initial 00:00 when begin() fires', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    render(<RecordingIndicator />);
    act(() => {
      useSessionRecordStore.getState().begin('session-1');
    });
    expect(screen.getByTestId('recording-indicator')).toBeTruthy();
    expect(screen.getByTestId('recording-indicator-timer').textContent).toBe('00:00');
  });

  it('advances timer once per second', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    render(<RecordingIndicator />);
    act(() => {
      useSessionRecordStore.getState().begin('session-1');
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('recording-indicator-timer').textContent).toBe('00:03');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('recording-indicator-timer').textContent).toBe('01:03');
  });

  it('unmounts when recording ends', () => {
    render(<RecordingIndicator />);
    act(() => {
      useSessionRecordStore.getState().begin('session-1');
    });
    expect(screen.queryByTestId('recording-indicator')).toBeTruthy();
    act(() => {
      useSessionRecordStore.getState().end();
    });
    expect(screen.queryByTestId('recording-indicator')).toBeNull();
  });
});
