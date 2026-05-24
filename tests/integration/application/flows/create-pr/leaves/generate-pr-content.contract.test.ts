import { describe, expect, it } from 'vitest';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';

const TS = '2026-05-23T10:00:00.000Z';

describe('generatePrContentOutputContract', () => {
  it('round-trips exampleSignals through signalsSchema (parses successfully)', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse(
      generatePrContentOutputContract.exampleSignals
    );
    expect(result.success).toBe(true);
  });

  it('rejects zero pr-content signals (exactlyOne refine)', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse([]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('exactly one pr-content');
    }
  });

  it('rejects two pr-content signals (exactlyOne refine)', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse([
      { type: 'pr-content', title: 'first', body: 'b', timestamp: TS },
      { type: 'pr-content', title: 'second', body: 'b', timestamp: TS },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('exactly one pr-content');
    }
  });

  it('rejects non-pr-content signal kinds (narrative fan-out is not part of the contract)', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse([
      { type: 'pr-content', title: 't', body: 'b', timestamp: TS },
      // `learning` is intentionally NOT part of the create-pr contract — narrative signals
      // would be silently dropped at post-implement time. Schema must reject.
      { type: 'learning', text: 'a learning', timestamp: TS },
    ]);
    expect(result.success).toBe(false);
  });

  it('exposes exactly one sidecar rule for pr-content', () => {
    expect(generatePrContentOutputContract.sidecars).toHaveLength(1);
    const rule = generatePrContentOutputContract.sidecars[0]!;
    expect(rule.signalKind).toBe('pr-content');
    expect(rule.filename).toBe('pr-content.md');
    expect(rule.multiplicity).toBe('one');
  });

  it('renders the pr-content sidecar body as `# title\\n\\nbody`', () => {
    const rule = generatePrContentOutputContract.sidecars[0]!;
    const body = (rule.extract as (s: { title: string; body: string; type: 'pr-content' }) => string)({
      type: 'pr-content',
      title: 'My title',
      body: 'My body',
    });
    expect(body).toBe('# My title\n\nMy body');
  });

  it('has no migrations (fresh contract introduced alongside the leaf)', () => {
    expect(Object.keys(generatePrContentOutputContract.migrations)).toHaveLength(0);
  });
});
