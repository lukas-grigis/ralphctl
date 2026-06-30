/**
 * Unit tests for the learnings.md renderer (Wave 2, Task 8). The mirror includes EVERY record —
 * promoted AND pending — each with a clear marker, grouped by repo then task-kind, with a LOCAL-time
 * timestamp. TZ is pinned for a deterministic timestamp column.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { renderLearningsMd } from '@src/application/flows/_shared/memory/render-learnings-md.ts';

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const rec = (over: Partial<LearningRecord>): LearningRecord => ({
  v: 1,
  id: 'id-0000000000000',
  text: 'an insight',
  repo: '/repo',
  repoName: 'demo',
  taskKind: 'feature',
  sprintId: 's1',
  taskId: 't1',
  timestamp: '2026-06-19T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

describe('renderLearningsMd', () => {
  it('empty set → a friendly placeholder', () => {
    const md = renderLearningsMd([]);
    expect(md).toContain('# Learnings');
    expect(md).toContain('No learnings recorded yet');
  });

  it('includes both promoted and pending records with distinct markers', () => {
    const md = renderLearningsMd([
      rec({ id: 'a', text: 'pending one', promotedAt: null }),
      rec({ id: 'b', text: 'promoted one', promotedAt: '2026-06-19T12:00:00.000Z' }),
    ]);
    expect(md).toContain('pending one');
    expect(md).toContain('promoted one');
    expect(md).toMatch(/pending.*pending one|pending one/);
    expect(md).toContain('promoted');
    // The summary line counts each bucket separately.
    expect(md).toContain('1 promoted, 0 declined, 1 pending');
  });

  it('renders a retired record with the declined marker + its retiredAt, never pending', () => {
    const md = renderLearningsMd([
      rec({ id: 'r', text: 'declined one', promotedAt: null, retiredAt: '2026-06-20T08:30:00.000Z' }),
    ]);
    expect(md).toContain('declined one');
    expect(md).toContain('⊘ declined');
    // A retired row has promotedAt: null but must NOT be mislabeled as pending.
    expect(md).not.toContain('○ pending');
    // The retiredAt timestamp is surfaced under a Declined label (TZ pinned to UTC).
    expect(md).toContain('Declined');
    expect(md).toContain('2026-06-20 08:30');
    // The summary counts it as declined, not pending.
    expect(md).toContain('0 promoted, 1 declined, 0 pending');
  });

  it('annotates a decision-kind record so it reads distinctly from a learning', () => {
    const md = renderLearningsMd([rec({ id: 'd', kind: 'decision', text: 'use ndjson for the ledger' })]);
    expect(md).toContain('use ndjson for the ledger');
    expect(md).toContain('· decision');
  });

  it('renders context + applies-to when present', () => {
    const md = renderLearningsMd([rec({ context: 'while refactoring', appliesTo: 'the loader' })]);
    expect(md).toContain('while refactoring');
    expect(md).toContain('the loader');
  });

  it('groups by repo then task-kind', () => {
    const md = renderLearningsMd([
      rec({ repoName: 'repo-a', taskKind: 'feature', text: 'A-feat' }),
      rec({ repoName: 'repo-a', taskKind: 'bugfix', text: 'A-bug' }),
      rec({ repoName: 'repo-b', taskKind: 'feature', text: 'B-feat' }),
    ]);
    expect(md).toContain('## repo-a');
    expect(md).toContain('## repo-b');
    expect(md).toContain('### feature');
    expect(md).toContain('### bugfix');
  });

  it('renders a LOCAL-time timestamp (TZ pinned to UTC)', () => {
    const md = renderLearningsMd([rec({ timestamp: '2026-06-19T10:07:00.000Z' })]);
    expect(md).toContain('2026-06-19 10:07');
  });

  it('collapses a multi-line insight into one bullet', () => {
    const md = renderLearningsMd([rec({ text: 'line one\nline two' })]);
    expect(md).toContain('line one line two');
    expect(md).not.toContain('line one\nline two');
  });
});
