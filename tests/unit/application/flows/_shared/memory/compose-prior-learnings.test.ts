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

  it('renders decisions under a sub-heading within the same block', () => {
    const out = composePriorLearnings([
      record({ text: 'tests need a real DB', kind: 'learning' }),
      record({ text: 'adopt hexagonal layering', kind: 'decision' }),
      record({ text: 'use one event bus per wire', kind: 'decision' }),
    ]);
    expect(out).toBe(
      '- tests need a real DB\n\nDecisions from prior sprints:\n- adopt hexagonal layering\n- use one event bus per wire'
    );
  });

  it('renders ONLY a decisions block when there are no learnings', () => {
    const out = composePriorLearnings([record({ text: 'adopt hexagonal layering', kind: 'decision' })]);
    expect(out).toBe('Decisions from prior sprints:\n- adopt hexagonal layering');
  });

  it('treats a legacy row with no kind as a learning (not a decision)', () => {
    const out = composePriorLearnings([record({ text: 'legacy insight' })]);
    expect(out).toBe('- legacy insight');
    expect(out).not.toContain('Decisions from prior sprints');
  });
});

describe('composePriorLearnings — relevance weighting', () => {
  it('ranks same-repo records above cross-repo records, most-relevant block first', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'cross A', repo: '/other' }),
        record({ text: 'same A', repo: '/repo' }),
        record({ text: 'cross B', repo: '/other' }),
        record({ text: 'same B', repo: '/repo' }),
      ],
      { repo: '/repo', taskKind: 'feature' }
    );
    // Same-repo (tier first, append order) then cross-repo (append order) — deterministic.
    expect(out).toBe('- same A\n- same B\n- cross A\n- cross B');
  });

  it('weights repo match above taskKind match', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'kind only', repo: '/other', taskKind: 'feature' }),
        record({ text: 'repo other kind', repo: '/repo', taskKind: 'bugfix' }),
        record({ text: 'neither', repo: '/other', taskKind: 'docs' }),
      ],
      { repo: '/repo', taskKind: 'feature' }
    );
    // repo match (score 2) > taskKind match (score 1) > neither (score 0).
    expect(out).toBe('- repo other kind\n- kind only\n- neither');
  });

  it('keeps the cap: cross-repo records ranked below same-repo are dropped when the cap fills', () => {
    const sameRepo = Array.from({ length: PRIOR_LEARNINGS_MAX + 3 }, (_, i) =>
      record({ text: `same-${String(i)}`, repo: '/repo' })
    );
    const out = composePriorLearnings([record({ text: 'cross', repo: '/other' }), ...sameRepo], {
      repo: '/repo',
      taskKind: 'feature',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(PRIOR_LEARNINGS_MAX);
    // Cross-repo record ranks below the same-repo tier, which alone overflows the cap → excluded.
    expect(out).not.toContain('cross');
    // Within the same-repo tier the newest survive; the oldest (same-0..2) are dropped.
    expect(out).toContain(`same-${String(PRIOR_LEARNINGS_MAX + 2)}`);
    expect(lines).not.toContain('- same-0');
  });

  it('without context, selection is recency-only regardless of repo/taskKind', () => {
    // No context → every record scores 0 → pure recency (newest N, append order). A cross-repo record
    // is NOT deprioritised here, proving the weighting only kicks in when a context is supplied.
    const out = composePriorLearnings([
      record({ text: 'first', repo: '/other' }),
      record({ text: 'second', repo: '/repo' }),
    ]);
    expect(out).toBe('- first\n- second');
  });
});
