import { describe, it, expect } from 'vitest';
import { ALL_HOLD_CODES, tierOf } from './tiers';

describe('tierOf', () => {
  it('puts blocking codes in tier 1', () => {
    expect(tierOf('blocked-menu')).toBe(1);
    expect(tierOf('autopilot-paused')).toBe(1);
    expect(tierOf('quota-rework')).toBe(1);
    expect(tierOf('critic-rework')).toBe(1);
    expect(tierOf('manual-steps')).toBe(1);
  });

  it('puts needs-a-look-soon codes in tier 2', () => {
    expect(tierOf('recap-attention')).toBe(2);
    expect(tierOf('halted-usage')).toBe(2);
    expect(tierOf('awaiting-merge')).toBe(2);
    expect(tierOf('stalled')).toBe(2);
    expect(tierOf('train-error')).toBe(2);
  });

  it('puts routine in-flight codes in tier 3', () => {
    expect(tierOf('ready-merge')).toBe(3);
    expect(tierOf('merging')).toBe(3);
    expect(tierOf('merge-rebasing')).toBe(3);
  });

  it('assigns a tier to every known code', () => {
    for (const code of ALL_HOLD_CODES) {
      expect([1, 2, 3]).toContain(tierOf(code));
    }
  });

  it('lists all 25 known codes exactly once', () => {
    expect(ALL_HOLD_CODES).toHaveLength(25);
    expect(new Set(ALL_HOLD_CODES).size).toBe(25);
  });

  // The tier table is this extension's own invention — Shepherd has no
  // HOLD_TIER map to mirror. So an unknown code is not hypothetical, it is
  // what every future Shepherd release looks like on day one.
  it('degrades an unknown code to tier 1 rather than dropping it', () => {
    expect(tierOf('some-code-shepherd-adds-in-2027')).toBe(1);
    expect(tierOf('')).toBe(1);
  });
});
