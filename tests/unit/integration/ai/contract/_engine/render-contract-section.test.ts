import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal, CommitMessageSignal } from '@src/domain/signal.ts';
import { commitMessageSignalSchema } from '@src/integration/ai/contract/_engine/signals/commit-message/schema.ts';
import { renderContractSection } from '@src/integration/ai/contract/_engine/render-contract-section.ts';

const ts = (): IsoTimestamp => {
  const r = IsoTimestamp.parse('2026-05-22T10:00:00.000Z');
  if (!r.ok) throw new Error('bad');
  return r.value;
};

describe('renderContractSection', () => {
  it('embeds a JSON example wrapped under { schemaVersion, signals }', () => {
    const example: CommitMessageSignal = { type: 'commit-message', subject: 'feat: x', timestamp: ts() };
    const out = renderContractSection({
      schemaVersion: 1,
      exampleSignals: [example],
      sidecars: [
        {
          signalKind: 'commit-message',
          filename: 'commit-message.txt',
          multiplicity: 'optional',
          extract: (s) => (s as CommitMessageSignal).subject,
        },
      ],
    });
    expect(out).toContain('## Output contract');
    expect(out).toContain('signals.json');
    expect(out).toContain('"schemaVersion": 1');
    expect(out).toContain('"type": "commit-message"');
    expect(out).toContain('commit-message.txt');
  });

  it('produces an example that round-trips through the corresponding signal schema', () => {
    const example: CommitMessageSignal = {
      type: 'commit-message',
      subject: 'feat(x): y',
      body: 'why this',
      timestamp: ts(),
    };
    const out = renderContractSection({
      schemaVersion: 1,
      exampleSignals: [example],
      sidecars: [],
    });
    // Extract the JSON block; matching the fenced ```json …``` body.
    const match = out.match(/```json\n([\s\S]+?)\n```/);
    expect(match).toBeTruthy();
    const parsed = JSON.parse(match![1]!) as { schemaVersion: number; signals: AiSignal[] };
    const arrSchema = z.array(commitMessageSignalSchema);
    const result = arrSchema.safeParse(parsed.signals);
    expect(result.success).toBe(true);
  });
});
