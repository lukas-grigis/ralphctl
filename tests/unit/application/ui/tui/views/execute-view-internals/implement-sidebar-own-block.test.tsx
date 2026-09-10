/**
 * The sidebar task-nav minimap keys its glyph/colour off `TaskBucket.status` — but a task blocked
 * on its OWN merits (budget exhausted, red verify, generator self-block) traces as a clean
 * `completed` (see `bucket-task-signals.ts`'s module docstring), so without correcting the bucket
 * against the polled entity first, the minimap would paint a stuck task the same green `phaseDone`
 * glyph as one that actually finished. `implement-sidebar-blocked-status.test.ts` already pins the
 * glyph/colour MAPS themselves; this pins the DERIVATION that decides which map entry a row uses.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { glyphFor } from '@src/application/ui/tui/theme/tokens.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const makeDescriptor = (): SessionDescriptor => ({
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'completed',
  startedAt: 0,
  trace: [],
  taskNames: new Map([
    ['task-self-blocked', 'Self-blocked task'],
    ['task-sibling', 'Sibling task'],
  ]),
});

describe('ImplementSidebar minimap — own-failure block', () => {
  it('paints the blocked glyph for a task the trace-only bucket reports completed', () => {
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const selfBlockedResult = markTaskBlocked(
      { ...todo, id: 'task-self-blocked' as TaskId },
      'budget exhausted',
      'own'
    );
    if (!selfBlockedResult.ok) throw new Error('fixture setup failed');

    const bucketed: BucketedExecution = {
      tasks: [
        { id: 'task-self-blocked', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
        { id: 'task-sibling', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
      ],
      orphanSignals: [],
    };

    const r = render(
      <ImplementSidebar
        sidebarWidth={40}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        sidebarContextSideBySide={false}
        descriptor={makeDescriptor()}
        bucketed={bucketed}
        isRunning={false}
        focusedTaskId={undefined}
        taskState={[selfBlockedResult.value]}
        now={0}
      />
    );
    const frame = r.lastFrame() ?? '';
    const selfBlockedLine = frame.split('\n').find((l) => l.includes('Self-blocked task'));
    const siblingLine = frame.split('\n').find((l) => l.includes('Sibling task'));

    expect(selfBlockedLine).toContain(glyphFor('blocked'));
    // The genuinely-completed sibling is untouched — still the plain `phaseDone` glyph, not blocked.
    expect(siblingLine).not.toContain(glyphFor('blocked'));
    r.unmount();
  });
});
