import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { changeParser } from '@src/integration/ai/signals/change/parser.ts';
import { decisionParser } from '@src/integration/ai/signals/decision/parser.ts';
import { learningParser } from '@src/integration/ai/signals/learning/parser.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

describe('learningParser', () => {
  it('extracts trimmed body and tags as type:learning', () => {
    const matches = learningParser.parse('<learning>  use exhaustive switches  </learning>', NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({ type: 'learning', text: 'use exhaustive switches', timestamp: NOW });
  });

  it('drops empty bodies', () => {
    expect(learningParser.parse('<learning>   </learning>', NOW)).toEqual([]);
  });

  it('finds multiple in document order', () => {
    const matches = learningParser.parse('<learning>a</learning> <learning>b</learning>', NOW);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => (m.signal.type === 'learning' ? m.signal.text : ''))).toEqual(['a', 'b']);
  });
});

describe('changeParser', () => {
  it('extracts body and tags as type:change', () => {
    const matches = changeParser.parse('<change>added foo()</change>', NOW);
    expect(matches[0]?.signal).toEqual({ type: 'change', text: 'added foo()', timestamp: NOW });
  });

  it('preserves multi-line body content', () => {
    const matches = changeParser.parse('<change>line one\nline two</change>', NOW);
    expect(matches[0]?.signal.type === 'change' && matches[0].signal.text).toBe('line one\nline two');
  });
});

describe('decisionParser', () => {
  it('tags as type:decision', () => {
    const matches = decisionParser.parse('<decision>chose path A over B</decision>', NOW);
    expect(matches[0]?.signal).toEqual({ type: 'decision', text: 'chose path A over B', timestamp: NOW });
  });
});
