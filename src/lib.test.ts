import { describe, expect, it } from 'vitest';
import { filterHandoffs } from './lib';
import { samples } from './samples';
import { draftSchema } from '@handoff/contracts';

describe('handoff dashboard', () => {
  it('filters by title, client and status together without modifying source order', () => {
    expect(filterHandoffs(samples, 'draft', ' kinFOLK ', 'newest').map(h => h.id)).toEqual(['kin']);
    expect(filterHandoffs(samples, 'ready', 'olive', 'newest')).toEqual([]);
    expect(filterHandoffs(samples, 'all', '', 'oldest').map(h => h.id)).toEqual(['kin', 'form', 'olive']);
    expect(samples.map(h => h.id)).toEqual(['olive', 'form', 'kin']);
  });
  it('shares currency precision validation with the backend', () => {
    expect(draftSchema.safeParse({ ...samples[0], amount: '1.000001', currency: 'NIM' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...samples[0], amount: '1.000001', currency: 'USDT' }).success).toBe(true);
    expect(draftSchema.safeParse({ ...samples[0], amount: '-1' }).success).toBe(false);
  });
});
