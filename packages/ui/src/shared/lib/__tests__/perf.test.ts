import { afterEach, describe, expect, it } from 'vitest';
import { clearPerfEntries, mark, measure } from '../perf.js';

describe('perf helpers', () => {
  afterEach(() => {
    clearPerfEntries();
  });

  it('mark/measure emit entries with the quanta: prefix', () => {
    mark('test.a');
    mark('test.b');
    const duration = measure('test.span', 'test.a', 'test.b');
    expect(typeof duration).toBe('number');
    const entries = performance.getEntriesByName('quanta:test.span');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('swallows errors when marks are missing', () => {
    // Using unique marks that never were set — should not throw.
    expect(() => measure('missing.span', 'nope.a', 'nope.b')).not.toThrow();
  });
});
