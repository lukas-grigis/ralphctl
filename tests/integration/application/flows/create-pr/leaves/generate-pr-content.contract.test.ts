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

  it('drops non-pr-content signal kinds and keeps the single pr-content (tolerant fan-out)', () => {
    // A mounted skill may coach a stray `<note>` / `<decision>` / `<learning>` during PR
    // authoring. The contract drops those rather than failing the whole array, so one stray
    // signal cannot silently defeat AI PR authoring — it keeps exactly the pr-content signal.
    const result = generatePrContentOutputContract.signalsSchema.safeParse([
      { type: 'learning', text: 'a learning', timestamp: TS },
      { type: 'pr-content', title: 't', body: 'b', timestamp: TS },
      { type: 'note', text: 'a note', timestamp: TS },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ type: 'pr-content', title: 't', body: 'b' });
    }
  });

  it('still rejects a stray-signal array with zero pr-content (drops to empty, then refine fails)', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse([
      { type: 'note', text: 'only a note', timestamp: TS },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('exactly one pr-content');
    }
  });

  it('still rejects a malformed pr-content signal (missing body) after filtering', () => {
    const result = generatePrContentOutputContract.signalsSchema.safeParse([
      { type: 'pr-content', title: 'no body', timestamp: TS },
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
