/**
 * The cross-project sprint picker's `N blocked` rollup badge.
 *
 * It shipped as `⚠ N blocked` while the Sprints-list row next door renders the same datum as an
 * iconless `· N blocked` (`TicketSubCount`) — two surfaces, one number, two visual languages.
 * DESIGN-SYSTEM §5.1 settles it: a rollup count is "a bold `inkColors.error` count + a dim label
 * … with the same bullet-separated, iconless shape", and "Don't prefix it with
 * `glyphs.warningGlyph` or any other icon".
 *
 * The badge's focus-only placement is deliberate and pre-dates the blocked-work work (the whole
 * `→ N tickets` detail line has always been focus-only), so these cases assert the shape on the
 * focused row and leave the placement alone.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { PickSprintView } from '@src/application/ui/tui/views/pick-sprint-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeProject, makeTodoTask, projectId } from '@tests/fixtures/domain.ts';

const PID = projectId('01900000-0000-7000-8000-0000000000b7');
const SID = ((): SprintId => {
  const r = SprintId.parse('01900000-0000-7000-8000-0000000010b7');
  if (!r.ok) throw new Error(`bad sprint id fixture: ${r.error.message}`);
  return r.value;
})();

const blockedTask = (name: string): Task => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'stuck', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

const sprint: Sprint = {
  id: SID,
  slug: 'stuck-sprint',
  name: 'stuck sprint',
  projectId: PID,
  status: 'active',
  tickets: [],
} as unknown as Sprint;

const stubDeps = (tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async list() {
        return Result.ok([sprint]);
      },
      async remove() {
        return Result.ok(undefined);
      },
    } as unknown as SprintRepository,
    projectRepo: {
      async list() {
        return Result.ok([{ ...makeProject({ displayName: 'Badge Project' }), id: PID } as unknown as Project]);
      },
    } as unknown as ProjectRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

/** The focused row's detail line — the only place the picker renders the badge. */
const detailLine = (frame: string): string => frame.split('\n').find((line) => line.includes('ticket')) ?? '';

describe('PickSprintView — blocked rollup badge', () => {
  it('renders the count and label with no warning-glyph prefix', async () => {
    const { result } = renderView(<PickSprintView />, {
      deps: stubDeps([blockedTask('one'), blockedTask('two')]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID, projectLabel: 'Badge Project' },
    });
    await waitFor(() => expect(detailLine(result.lastFrame() ?? '')).toContain('blocked'));

    const line = detailLine(result.lastFrame() ?? '');
    expect(line).toContain('2 blocked');
    // The Sprints-list separator, not an icon — same shape `pending` / `approved` use there.
    expect(line).toContain(`${glyphs.bullet} 2 blocked`);
    expect(line).not.toContain(glyphs.warningGlyph);
    result.unmount();
  });

  it('omits the badge entirely when nothing is blocked', async () => {
    const { result } = renderView(<PickSprintView />, {
      deps: stubDeps([makeTodoTask({ name: 'runnable' })]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID, projectLabel: 'Badge Project' },
    });
    // Waiting for the ticket line IS an anchored wait for the health fetch: `usePickerRows`
    // awaits `loadTaskHealthBySprintId` inside the same `useAsyncLoad` payload as the sprint
    // list, and `AsyncListFrame` renders the spinner until that payload resolves — so no row,
    // and no detail line, can paint on a half-loaded map. Verified by mutation: flipping the
    // badge's gate to `>= 0` fails this case on `↳ 0 tickets · 0 blocked`.
    await waitFor(() => expect(detailLine(result.lastFrame() ?? '')).toContain('ticket'));

    expect(detailLine(result.lastFrame() ?? '')).not.toContain('blocked');
    result.unmount();
  });
});
