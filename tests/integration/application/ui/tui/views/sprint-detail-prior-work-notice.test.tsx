import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksSection } from '@src/application/ui/tui/views/sprint-detail-internals/task-summary.tsx';
import { buildFocusList } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

const sprint = makeActiveSprint();
const blockedTask = (() => {
  const r = markTaskBlocked(makeTodoTask(), 'attempt budget exhausted', 'own', { blockCause: 'budget-exhausted' });
  if (!r.ok) throw new Error(r.error.message);
  return {
    ...r.value,
    quarantinedDiff: { stashMessage: 'm', stat: { files: 5, insertions: 142, deletions: 38 } },
  };
})();

describe('Sprint detail prior-work notice', () => {
  it.each([false, true])('renders on the card (expanded=%s)', (expanded) => {
    const tasks = [blockedTask];
    const r = render(
      <TasksSection
        sprint={sprint}
        tasks={tasks}
        focusList={buildFocusList(sprint, tasks)}
        cursorIdx={0}
        project={makeProject()}
        openIds={new Set(expanded ? [String(blockedTask.id)] : [])}
      />
    );
    const frame = r.lastFrame() ?? '';
    r.unmount();
    expect(frame).toContain('rejected diff kept in git stash · 5 files +142 -38');
    expect(frame).toContain('u unblocks and decides');
  });
});
