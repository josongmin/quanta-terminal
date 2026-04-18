import { describe, expect, it } from 'vitest';
import {
  compareBannerCondition,
  pickBannerCondition,
  type BannerCondition,
} from '../banner-precedence.js';

describe('pickBannerCondition', () => {
  it('returns undefined when nothing is active', () => {
    expect(pickBannerCondition([])).toBeUndefined();
  });

  it('returns the single condition when only one is active', () => {
    expect(pickBannerCondition(['quota'])).toBe('quota');
  });

  it('respects precedence order: crash > quota > secret_rescan > shell_integration', () => {
    const all: BannerCondition[] = ['shell_integration', 'secret_rescan', 'quota', 'crash'];
    expect(pickBannerCondition(all)).toBe('crash');
    expect(pickBannerCondition(['quota', 'secret_rescan', 'shell_integration'])).toBe('quota');
    expect(pickBannerCondition(['secret_rescan', 'shell_integration'])).toBe('secret_rescan');
    expect(pickBannerCondition(['shell_integration'])).toBe('shell_integration');
  });
});

describe('compareBannerCondition', () => {
  it('totals to a transitive ordering', () => {
    const order: BannerCondition[] = [
      'shell_integration',
      'secret_rescan',
      'quota',
      'crash',
    ];
    // each index i outranks every index < i
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        expect(compareBannerCondition(order[i]!, order[j]!)).toBeGreaterThan(0);
        expect(compareBannerCondition(order[j]!, order[i]!)).toBeLessThan(0);
      }
    }
  });
});
