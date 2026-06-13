import { describe, expect, it } from 'vitest';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  composePriorLearnings,
  PRIOR_LEARNINGS_MAX,
} from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';

const record = (overrides: Partial<LearningRecord> & { text: string }): LearningRecord => ({
  v: 1,
  id: overrides.text.slice(0, 16),
  repo: '/repo',
  repoName: 'repo',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-06-12T00:00:00.000Z',
  promotedAt: null,
  ...overrides,
});

describe('composePriorLearnings', () => {
  it('returns empty string for no records', () => {
    expect(composePriorLearnings([])).toBe('');
  });

  it('renders one bullet per learning insight', () => {
    const out = composePriorLearnings([
      record({ text: 'tests need a real DB' }),
      record({ text: 'module Y is coupled' }),
    ]);
    expect(out).toBe('- tests need a real DB\n- module Y is coupled');
  });

  it('appends the optional applies-to inline', () => {
    const out = composePriorLearnings([record({ text: 'flaky e2e', appliesTo: 'web app' })]);
    expect(out).toBe('- flaky e2e (applies to web app)');
  });

  it('drops empty-insight records', () => {
    const out = composePriorLearnings([record({ text: '   ' }), record({ text: 'real one' })]);
    expect(out).toBe('- real one');
  });

  it('keeps only the most recent N records (tail = newest by append order)', () => {
    const many = Array.from({ length: PRIOR_LEARNINGS_MAX + 5 }, (_, i) => record({ text: `learning ${String(i)}` }));
    const out = composePriorLearnings(many);
    const lines = out.split('\n');
    expect(lines).toHaveLength(PRIOR_LEARNINGS_MAX);
    // The oldest (learning 0..4) are dropped; the newest (last) survives.
    expect(out).toContain(`learning ${String(PRIOR_LEARNINGS_MAX + 4)}`);
    expect(out).not.toContain('learning 0\n');
  });

  it('collapses internal whitespace into a single line', () => {
    const out = composePriorLearnings([record({ text: 'a\n  multi\tline   insight' })]);
    expect(out).toBe('- a multi line insight');
  });
});
