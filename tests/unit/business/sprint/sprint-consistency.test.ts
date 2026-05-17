import { describe, expect, it } from 'vitest';
import { validateSprintConsistency } from '@src/business/sprint/sprint-consistency.ts';
import {
  FIXED_PROJECT_ID,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makeDraftSprintBundle,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { createSprintWithExecution } from '@src/domain/entity/sprint.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';

describe('validateSprintConsistency', () => {
  const buildBundle = () => {
    const ticket = makeApprovedTicket();
    const r = createSprintWithExecution({
      name: 's',

      projectId: FIXED_PROJECT_ID,
    });
    if (!r.ok) throw new Error('seed');
    const sprint = { ...r.value.sprint, tickets: [ticket] };
    const project = makeProject();
    const task = makeTodoTask({ ticketId: ticket.id, repositoryId: FIXED_REPOSITORY_ID });
    return { project, sprint, execution: r.value.execution, tasks: [task], ticket };
  };

  it('passes a consistent bundle', () => {
    const { project, sprint, execution, tasks } = buildBundle();
    const r = validateSprintConsistency({ project, sprint, execution, tasks });
    expect(r.ok).toBe(true);
  });

  it('rejects when sprint.projectId mismatches project.id', () => {
    const b = buildBundle();
    const wrong = makeProject({ id: ProjectId.generate() });
    const r = validateSprintConsistency({ ...b, project: wrong });
    expect(r.ok).toBe(false);
  });

  it('rejects when execution.sprintId mismatches sprint.id', () => {
    const b = buildBundle();
    const otherBundle = makeDraftSprintBundle({ name: 'other' });
    const r = validateSprintConsistency({ ...b, execution: otherBundle.execution });
    expect(r.ok).toBe(false);
  });

  it('rejects task referencing unknown ticket', () => {
    const b = buildBundle();
    const ghost = makeTodoTask({ repositoryId: FIXED_REPOSITORY_ID });
    const r = validateSprintConsistency({ ...b, tasks: [ghost] });
    expect(r.ok).toBe(false);
  });

  it('rejects task referencing unknown repository', () => {
    const b = buildBundle();
    const wrong = makeTodoTask({ ticketId: b.ticket.id, repositoryId: RepositoryId.generate() });
    const r = validateSprintConsistency({ ...b, tasks: [wrong] });
    expect(r.ok).toBe(false);
  });

  it('passes through TaskGraphIssue from validateTaskGraph', () => {
    const b = buildBundle();
    // Self-edge via setTaskDependsOn would normally be rejected; bypass for the test.
    const broken = { ...b.tasks[0]!, dependsOn: [b.tasks[0]!.id] };
    const r = validateSprintConsistency({ ...b, tasks: [broken] });
    expect(r.ok).toBe(false);
  });
});
