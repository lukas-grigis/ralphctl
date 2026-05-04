import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { PlanSprintTasksUseCase } from './plan-sprint-tasks.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const PROJECT_PATH = '/repos/demo';

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function cwd(): AbsolutePath {
  const r = AbsolutePath.parse('/tmp/ralphctl-plan');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectPath(): AbsolutePath {
  const r = AbsolutePath.parse(PROJECT_PATH);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function approvedSprint(): Sprint {
  const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
  if (!sprint.ok) throw new Error('precondition failed');

  const tid = TicketId.parse('aaaaaaaa');
  if (!tid.ok) throw new Error('precondition failed');
  const ticket = Ticket.create({ id: tid.value, title: 'do X' });
  if (!ticket.ok) throw new Error('precondition failed');
  const approved = ticket.value.approveRequirements('must do X');
  if (!approved.ok) throw new Error('precondition failed');

  const withTicket = sprint.value.addTicket(approved.value);
  if (!withTicket.ok) throw new Error('precondition failed');

  // Real plan flow runs `persist-repo-selection` before the use case fires,
  // so the sprint always has affectedRepositories set by the time we get
  // here. Mirror that contract in the fixture so the projectPath guard
  // matches production behaviour.
  const withRepos = withTicket.value.setAffectedRepositories([projectPath()]);
  if (!withRepos.ok) throw new Error('precondition failed');
  return withRepos.value;
}

function tasksJson(): string {
  return JSON.stringify([
    {
      name: 'first task',
      description: 'do the thing',
      steps: ['step 1'],
      verificationCriteria: ['criteria 1'],
      order: 1,
      ticketId: 'aaaaaaaa',
      projectPath: PROJECT_PATH,
    },
    {
      name: 'second task',
      steps: [],
      verificationCriteria: [],
      order: 2,
      projectPath: PROJECT_PATH,
    },
  ]);
}

describe('PlanSprintTasksUseCase', () => {
  it('parses a fenced JSON task list and returns Task entities', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '```json\n' + tasksJson() + '\n```' } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toHaveLength(2);
    expect(result.value.tasks[0]?.name).toBe('first task');
    expect(result.value.tasks[0]?.order).toBe(1);
    expect(result.value.tasks[1]?.name).toBe('second task');
  });

  it('supports a bare JSON array (no fence)', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: tasksJson() } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toHaveLength(2);
  });

  it('rejects a non-draft sprint with InvalidStateError', async () => {
    const sprint = approvedSprint();
    const active = sprint.activate(T0);
    if (!active.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: active.value,
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      if (result.error.code === 'invalid-state') {
        expect(result.error.attemptedAction).toBe('plan');
      }
    }
    expect(ai.captured).toHaveLength(0);
  });

  it('rejects a sprint whose tickets are not all approved', async () => {
    const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
    if (!sprint.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');
    const ticket = Ticket.create({ id: tid.value, title: 'pending' });
    if (!ticket.ok) throw new Error('precondition failed');
    const withTicket = sprint.value.addTicket(ticket.value);
    if (!withTicket.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: withTicket.value,
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      if (result.error.code === 'invalid-state') {
        expect(result.error.currentState).toBe('tickets-not-approved');
      }
    }
  });

  it('rejects a sprint with zero tickets (nothing to plan)', async () => {
    const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
    if (!sprint.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: sprint.value,
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
    }
  });

  it('returns ParseError on malformed JSON', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'not json at all' } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      if (result.error.code === 'parse-error') {
        expect(result.error.subCode).toBe('invalid-json');
      }
    }
  });

  it('returns ParseError when JSON is not an array of objects', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '```json\n{"not": "an array"}\n```' } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      if (result.error.code === 'parse-error') {
        expect(result.error.subCode).toBe('schema-mismatch');
      }
    }
  });

  it('returns ParseError when a task entry is missing projectPath', async () => {
    const malformed = JSON.stringify([{ name: 'broken', steps: [], verificationCriteria: [], order: 1 }]);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: malformed } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
    }
  });

  it('rejects a task whose ticketId does not match any sprint ticket', async () => {
    // The AI must never invent ticketIds — every emitted ticketId must be
    // one of the sprint's tickets. Catch this at parse time so the failure
    // surfaces with context, not later as an orphaned task in the UI.
    const unknownTicketId = 'bbbbbbbb';
    const output = JSON.stringify([
      {
        name: 'orphan task',
        steps: ['do it'],
        verificationCriteria: ['works'],
        order: 1,
        ticketId: unknownTicketId,
        projectPath: PROJECT_PATH,
      },
    ]);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      if (result.error.code === 'parse-error') {
        expect(result.error.subCode).toBe('schema-mismatch');
        expect(result.error.message).toContain('does not match any sprint ticket');
        expect(result.error.message).toContain(unknownTicketId);
      }
    }
  });

  it('rejects a task whose projectPath is not in sprint.affectedRepositories', async () => {
    // The AI is told to use exact paths from the project's Repositories
    // section. If it hallucinates a path, the per-task chain would either
    // ENOENT at session-spawn or run Claude in an unrelated directory.
    // Surface the failure here with the allowed list.
    const output = JSON.stringify([
      {
        name: 'rogue task',
        steps: [],
        verificationCriteria: [],
        order: 1,
        ticketId: 'aaaaaaaa',
        projectPath: '/repos/wrong-place',
      },
    ]);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      if (result.error.code === 'parse-error') {
        expect(result.error.subCode).toBe('schema-mismatch');
        expect(result.error.message).toContain("not one of the sprint's affected repositories");
        expect(result.error.message).toContain('/repos/wrong-place');
        expect(result.error.message).toContain(PROJECT_PATH);
      }
    }
  });

  it('rejects an empty task list with ParseError', async () => {
    // `[]` is valid JSON but useless — fail loudly here rather than letting
    // the chain proceed and trip `assert-tasks-not-empty` deep in execute.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '[]' } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      if (result.error.code === 'parse-error') {
        expect(result.error.subCode).toBe('schema-mismatch');
        expect(result.error.message).toContain('empty task list');
      }
    }
  });

  it('propagates an AI session failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn failed' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: tasksJson() } }],
    });
    const uc = new PlanSprintTasksUseCase(ai, new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      promptFilePath: '/tmp/sprints/a/contexts/plan.md',
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
