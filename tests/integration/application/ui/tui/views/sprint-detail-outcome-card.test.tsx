/**
 * Outcome report card — renders the harness-outcome rollup for a `review` / `done` sprint from
 * its already-loaded tasks, and falls back to a graceful "no attempt data" line for an empty /
 * legacy sprint rather than crashing.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import {
  recordRunningAttemptVerification,
  recordRunningAttemptWarning,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { failCurrentAttempt, markTaskDone, recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { OutcomeReportCard } from '@src/application/ui/tui/views/sprint-detail-internals/outcome-card.tsx';
import { FIXED_LATER, FIXED_LATEST, FIXED_NOW, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`fixture unwrap failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

const beginAttempt = (task: Task): InProgressTask => unwrap(startNextAttempt(task, FIXED_NOW, 'session-1'));

const ENTROPY_PLATEAU: AttemptWarning = { kind: 'plateau', dimensions: [], source: 'entropy' };

const buildTasks = (): readonly Task[] => {
  // alpha — done clean, first attempt.
  const alphaVerified = unwrap(recordRunningAttemptVerification(beginAttempt(makeTodoTask({ name: 'alpha' }))));
  const alpha = unwrap(markTaskDone(alphaVerified, FIXED_LATER));

  // bravo — the model escalation rung fires, then resolves (settles done).
  const bravoEscalated = unwrap(
    recordTaskEscalation(beginAttempt(makeTodoTask({ name: 'bravo' })), 'model-a', 'model-b')
  );
  const bravoVerified = unwrap(recordRunningAttemptVerification(bravoEscalated));
  const bravo = applyCriteriaVerdicts(unwrap(markTaskDone(bravoVerified, FIXED_LATEST)), [{ id: 'C1', passed: true }]);

  // charlie — plateaus (entropy detector) on its only attempt and settles blocked.
  const charlieWarned = unwrap(
    recordRunningAttemptWarning(beginAttempt(makeTodoTask({ name: 'charlie' })), ENTROPY_PLATEAU)
  );
  const charlieFailed = unwrap(failCurrentAttempt(charlieWarned, FIXED_LATER, 'failed'));
  const charlie = applyCriteriaVerdicts(unwrap(markTaskBlocked(charlieFailed, 'verification never passed', 'own')), [
    { id: 'C1', passed: false },
  ]);

  return [alpha, bravo, charlie];
};

describe('OutcomeReportCard — a sprint with attempts, an escalation, and a plateau', () => {
  it('renders the outcome mix, first-pass rate, plateau source, escalation rung, and criteria k/N', () => {
    const { lastFrame } = render(<OutcomeReportCard sprint={makeReviewSprint()} tasks={buildTasks()} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Outcome report');
    expect(frame).toContain('2 clean');
    expect(frame).toContain('0 warn');
    expect(frame).toContain('1 blocked');
    expect(frame).toContain('0 open');
    expect(frame).toContain('2/2 (100%)');
    expect(frame).toContain('entropy');
    expect(frame).toContain('Model');
    expect(frame).toContain('1 granted');
    expect(frame).toContain('1 resolved');
    expect(frame).toContain('1/3 passed (33%)');
    expect(frame).toContain('1 unknown');
  });
});

describe('OutcomeReportCard — an empty / legacy sprint with no attempt data', () => {
  it('renders a graceful fallback line instead of crashing', () => {
    const { lastFrame } = render(<OutcomeReportCard sprint={makeReviewSprint()} tasks={[]} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Outcome report');
    expect(frame).toContain('No attempt data recorded for this sprint.');
  });
});
