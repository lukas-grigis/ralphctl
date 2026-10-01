/**
 * Sprints at 80x24: the overflow cue counts sprints that are really hidden, and the `· N sprints` footer is never the
 * thing the scroll region clips.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const sprint = (n: number): Record<string, unknown> => ({
  id: `s${String(n)}`,
  slug: `s-${String(n)}`,
  name: `Sprint ${String(n)}`,
  projectId: 'p',
  status: 'draft',
  tickets: [],
});

describe('SprintsView overflow', () => {
  it('shows N cards plus an honest "M more" whose sum is the sprint count, with the footer intact', async () => {
    const sprints = [sprint(3), sprint(2), sprint(1)];
    const deps = {
      sprintRepo: {
        async list() {
          return Result.ok(sprints);
        },
      },
      taskRepo: {
        async findBySprintId() {
          return Result.ok([]);
        },
      },
      clock: () => IsoTimestamp.now(),
      logger: noopLogger,
    } as never;
    const { result } = renderView(<SprintsView />, {
      deps,
      initial: { id: 'sprints' },
      size: { columns: 80, rows: 24 },
    });
    await waitForViewReady(result, (f) => f.includes('Sprint 3'));
    const frame = result.lastFrame() ?? '';
    const cards = frame.split('\n').filter((l) => l.startsWith('╭')).length;
    const more = Number(/▾ (\d+) more/.exec(frame)?.[1] ?? 0);
    expect(cards + more).toBe(3);
    expect(frame).toContain('3 sprints');
  });
});
