/**
 * Sprint-detail view — ticket / task card harmony.
 *
 * Both card types render through the shared `ListCard` primitive, so they must agree on the
 * structural visual contract: identical left + right border columns and identical border
 * frame shape (same top / bottom border line). These tests guard against future regressions
 * where someone reintroduces a bespoke wrapper around `Card` for one of the lists and the
 * two visually drift apart.
 *
 * A separate group exercises the responsive task-metadata row: single-line + ellipsis at
 * terminal widths ≥ 100 cols, wrapping below that threshold.
 *
 * `useTerminalSize` is mocked so the responsive predicate (`useBreakpoint`) sees the width
 * we want regardless of the test stdout's hardcoded 100 cols. The actual layout box is
 * still bounded by stdout columns — that's fine: width-based truncation in Ink fires at the
 * actual layout width, so the `…` clip marker shows up for content that overflows the
 * stdout box. ink-testing-library's stdout strips chalk colour, so border tone identity
 * is asserted structurally (same border characters at the same columns) rather than by
 * ANSI sequence comparison.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const sizeRef = vi.hoisted(() => ({ columns: 120, rows: 40 }));

vi.mock('@src/application/ui/tui/runtime/use-terminal-size.ts', () => ({
  useTerminalSize: (): { columns: number; rows: number } => ({ columns: sizeRef.columns, rows: sizeRef.rows }),
}));

import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE_PATTERN, '');

const makeSprint = (tickets: readonly unknown[]): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj-fixture' as never,
    // `done` keeps the "Next phase" affordance as plain text rather than a card so the only
    // bordered frames in the rendered tree are the sprint header, the tickets, and the tasks.
    status: 'done',
    tickets,
  }) as unknown as Sprint;

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

interface CardFrame {
  readonly topLine: string;
  readonly leftCol: number;
  readonly rightCol: number;
}

/**
 * Find the bordered card surrounding the header line containing `marker`. The top border is
 * the line directly above the marker, and the left / right border columns are the indices of
 * the `╭` / `╮` glyphs on that top line.
 */
const findCard = (lines: readonly string[], marker: string): CardFrame | undefined => {
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx <= 0) return undefined;
  const topLine = lines[idx - 1] ?? '';
  const leftCol = topLine.indexOf('╭');
  const rightCol = topLine.lastIndexOf('╮');
  if (leftCol < 0 || rightCol < 0) return undefined;
  return { topLine, leftCol, rightCol };
};

describe('SprintDetailView — ticket / task card harmony', () => {
  beforeEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 40;
  });
  afterEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 40;
  });

  it('ticket card and task card share identical border alignment and unfocused tone at width 120', async () => {
    sizeRef.columns = 120;
    const sprint = makeSprint([
      { id: 'ticket-a' as never, title: 'alpha-card-marker', status: 'approved' } as never,
      { id: 'ticket-b' as never, title: 'bravo-card-marker', status: 'approved' } as never,
    ]);
    const tasks: readonly Task[] = [
      {
        id: 'task-alpha' as never,
        name: 'alpha-task-marker',
        status: 'todo',
        dependsOn: [],
        attempts: [],
        ticketId: 'ticket-a' as never,
        repositoryId: 'r1' as never,
        order: 1,
        steps: [],
        verificationCriteria: [],
      } as never,
    ];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await tick(60);

    const frame = stripAnsi(result.lastFrame() ?? '');
    const lines = frame.split('\n');

    // Default cursor sits on ticket #0 (alpha). That makes alpha focused and bravo +
    // alpha-task unfocused. Compare bravo vs alpha-task — both unfocused cards must agree
    // on every aspect of their frame.
    const ticketCard = findCard(lines, 'bravo-card-marker');
    const taskCard = findCard(lines, 'alpha-task-marker');

    expect(ticketCard).toBeDefined();
    expect(taskCard).toBeDefined();
    if (ticketCard === undefined || taskCard === undefined) return;

    // Column alignment: both cards live in the same outer column stack, so their borders
    // must land in the same columns. A regression where one card path picked up extra
    // padding / margin would surface here as a left- or right-col mismatch.
    expect(ticketCard.leftCol).toBe(taskCard.leftCol);
    expect(ticketCard.rightCol).toBe(taskCard.rightCol);

    // Tone identity at the structural level: both unfocused cards must produce a
    // character-identical top border (same border glyphs, same width, same horizontal
    // extent). If a future change splits the two paths (e.g. a different border style,
    // padding, or dim policy on one of them) the top borders would diverge — even with
    // chalk colour stripped from the test stdout, the border characters and their
    // positions remain visible signal.
    expect(ticketCard.topLine).toBe(taskCard.topLine);
  });
});

describe('SprintDetailView — task metadata row wrap policy', () => {
  beforeEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 40;
  });
  afterEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 40;
  });

  const buildMetadataHeavyTask = (id: string): Task =>
    ({
      id: id as never,
      name: 'meta-task',
      status: 'todo',
      dependsOn: ['dep-a' as never, 'dep-b' as never, 'dep-c' as never],
      attempts: [],
      maxAttempts: 5,
      ticketId: 'ticket-a' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    }) as never;

  it('keeps the task metadata row on a single line with an ellipsis at width 120', async () => {
    sizeRef.columns = 120;
    // The ticket title is intentionally long so the metadata row overflows even the
    // generous stdout box. We expect Ink to ellide the tail with `…` rather than wrap.
    const longTicketTitle = 'an-intentionally-long-ticket-title-that-pushes-the-metadata-row-past-the-line-budget';
    const sprint = makeSprint([{ id: 'ticket-a' as never, title: longTicketTitle, status: 'approved' } as never]);
    const tasks: readonly Task[] = [buildMetadataHeavyTask('task-meta-wide')];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await tick(60);

    const frame = stripAnsi(result.lastFrame() ?? '');
    const lines = frame.split('\n');

    // The metadata line is the one carrying `· ticket:` plus the depends-on count. Wrapping
    // would split those across multiple lines; truncation keeps them on one line whose tail
    // ends in the ellipsis glyph.
    const metaLines = lines.filter((l) => l.includes('· ticket:'));
    expect(metaLines.length).toBe(1);
    expect(metaLines[0]).toContain('…');
    // The depends-on count should NOT appear on its own row (it would have wrapped).
    const standaloneDepsLine = lines.find((l) => l.includes('3 deps') && !l.includes('· ticket:'));
    expect(standaloneDepsLine).toBeUndefined();
  });

  it('allows the task metadata row to wrap onto multiple lines below 100 cols', async () => {
    sizeRef.columns = 80;
    // Same long ticket title as the truncate test so the metadata row is wider than the
    // stdout content area. With the wrap-policy branch active (mocked columns < md), the
    // overflow tail must land on a second line instead of being elided away.
    const longTicketTitle = 'an-intentionally-long-ticket-title-that-pushes-the-metadata-row-past-the-line-budget';
    const sprint = makeSprint([{ id: 'ticket-a' as never, title: longTicketTitle, status: 'approved' } as never]);
    const tasks: readonly Task[] = [buildMetadataHeavyTask('task-meta-narrow')];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await tick(60);

    const frame = stripAnsi(result.lastFrame() ?? '');
    const lines = frame.split('\n');

    // With wrap behaviour, fields scatter across multiple metadata rows; the wrapping path
    // never emits the truncation ellipsis, since flexbox absorbs the overflow instead.
    const metadataRows = lines.filter(
      (l) => l.includes('ticket:') || l.includes('repo:') || l.includes('attempts:') || /\b3 deps\b/.test(l)
    );
    expect(metadataRows.length).toBeGreaterThan(1);
    const metaLineWithEllipsis = metadataRows.find((l) => l.includes('…'));
    expect(metaLineWithEllipsis).toBeUndefined();
  });
});
