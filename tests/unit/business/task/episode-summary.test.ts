import { describe, expect, it } from 'vitest';
import type { TaskEpisode } from '@src/domain/repository/episode/episode-types.ts';
import { summariseEpisodes } from '@src/business/task/episode-summary.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const TS = '2026-06-27T00:00:00.000Z' as IsoTimestamp;

const makeEpisode = (overrides: Partial<TaskEpisode> = {}): TaskEpisode => ({
  taskId: 'task-1',
  sprintId: 'sprint-1',
  goal: 'Wire up the CSV export endpoint',
  outcome: 'success',
  keyLearnings: 'Use streaming to avoid OOM on large result sets',
  timestamp: TS,
  ...overrides,
});

describe('summariseEpisodes', () => {
  it('returns empty string for an empty episode list', () => {
    expect(summariseEpisodes([])).toBe('');
  });

  it('formats a single episode as a bullet line', () => {
    const ep = makeEpisode();
    const out = summariseEpisodes([ep]);
    expect(out).toBe('- Wire up the CSV export endpoint → success (Use streaming to avoid OOM on large result sets)');
  });

  it('formats multiple episodes as one bullet per line', () => {
    const episodes = [
      makeEpisode({ goal: 'Add rate-limit middleware', outcome: 'success', keyLearnings: 'Token bucket works well' }),
      makeEpisode({
        goal: 'Fix auth token refresh',
        outcome: 'partial',
        keyLearnings: 'Edge case with expired refresh token not covered',
      }),
      makeEpisode({
        goal: 'Wire logging pipeline',
        outcome: 'success',
        keyLearnings: 'Use async transport to avoid blocking',
      }),
    ];
    const out = summariseEpisodes(episodes);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Add rate-limit middleware');
    expect(lines[0]).toContain('success');
    expect(lines[0]).toContain('Token bucket works well');
    expect(lines[1]).toContain('Fix auth token refresh');
    expect(lines[1]).toContain('partial');
    expect(lines[2]).toContain('Wire logging pipeline');
  });

  it('keeps only the last maxItems episodes when the list is longer', () => {
    const episodes = Array.from({ length: 10 }, (_, i) =>
      makeEpisode({
        taskId: `task-${String(i)}`,
        goal: `Task ${String(i)}`,
        outcome: 'success',
        keyLearnings: `learning ${String(i)}`,
      })
    );
    const out = summariseEpisodes(episodes, 3);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // Should be the last 3: Task 7, Task 8, Task 9
    expect(lines[0]).toContain('Task 7');
    expect(lines[1]).toContain('Task 8');
    expect(lines[2]).toContain('Task 9');
  });

  it('defaults maxItems to 5 when not provided', () => {
    const episodes = Array.from({ length: 8 }, (_, i) =>
      makeEpisode({ taskId: `task-${String(i)}`, goal: `Task ${String(i)}`, outcome: 'success', keyLearnings: 'ok' })
    );
    const out = summariseEpisodes(episodes);
    const lines = out.split('\n');
    expect(lines).toHaveLength(5);
    // Last 5: Task 3–7
    expect(lines[0]).toContain('Task 3');
    expect(lines[4]).toContain('Task 7');
  });

  it('truncates long goals with an ellipsis at 80 characters', () => {
    const longGoal = 'A'.repeat(100);
    const out = summariseEpisodes([makeEpisode({ goal: longGoal })]);
    // Should be truncated: 80 chars + ellipsis
    expect(out).toContain('…');
    // The full 100-char goal should NOT appear verbatim
    expect(out).not.toContain(longGoal);
    // The truncated portion should be present
    expect(out).toContain('A'.repeat(80));
  });

  it('includes the outcome and keyLearnings for all outcome types', () => {
    const outcomes = ['success', 'partial', 'blocked', 'abandoned'] as const;
    for (const outcome of outcomes) {
      const out = summariseEpisodes([makeEpisode({ outcome, keyLearnings: `learning for ${outcome}` })]);
      expect(out).toContain(`→ ${outcome}`);
      expect(out).toContain(`learning for ${outcome}`);
    }
  });

  it('trims whitespace from keyLearnings', () => {
    const out = summariseEpisodes([makeEpisode({ keyLearnings: '  padded learning  ' })]);
    expect(out).toContain('(padded learning)');
    expect(out).not.toContain('  padded learning  ');
  });
});
