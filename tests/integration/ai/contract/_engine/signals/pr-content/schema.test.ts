import { describe, expect, it } from 'vitest';
import { prContentSignalSchema } from '@src/integration/ai/contract/_engine/signals/pr-content/schema.ts';

const TS = '2026-05-23T10:00:00.000Z';

describe('prContentSignalSchema', () => {
  it('accepts a valid payload', () => {
    const result = prContentSignalSchema.safeParse({
      type: 'pr-content',
      title: 'Add CSV export',
      body: 'Body content.',
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = prContentSignalSchema.safeParse({
      type: 'pr-content',
      body: 'Body content.',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing body', () => {
    const result = prContentSignalSchema.safeParse({
      type: 'pr-content',
      title: 'Add CSV export',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong type discriminator', () => {
    const result = prContentSignalSchema.safeParse({
      type: 'not-pr-content',
      title: 'Add CSV export',
      body: 'Body content.',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string title', () => {
    const result = prContentSignalSchema.safeParse({
      type: 'pr-content',
      title: 42,
      body: 'Body content.',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });
});
