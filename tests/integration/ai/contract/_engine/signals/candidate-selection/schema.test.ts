import { describe, expect, it } from 'vitest';
import { candidateSelectionSignalSchema } from '@src/integration/ai/contract/_engine/signals/candidate-selection/schema.ts';

const TS = '2026-05-23T10:00:00.000Z';

describe('candidateSelectionSignalSchema', () => {
  it('accepts a valid payload naming candidate 1', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: 1,
      rationale: 'Candidate 1 ran the repro command and cited the passing output; Candidate 2 did not verify.',
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid payload naming candidate 2', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: 2,
      rationale: 'Candidate 2 stayed within the declared scope; Candidate 1 touched an unrelated file.',
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a zero winner', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: 0,
      rationale: 'x',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative winner', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: -1,
      rationale: 'x',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer winner', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: 1.5,
      rationale: 'x',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing rationale', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: 1,
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-number winner', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'candidate-selection',
      winner: '1',
      rationale: 'x',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects the wrong type discriminator', () => {
    const result = candidateSelectionSignalSchema.safeParse({
      type: 'not-candidate-selection',
      winner: 1,
      rationale: 'x',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });
});
