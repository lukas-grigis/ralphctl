import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Task } from '../../../domain/entities/task.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { FakeAiSessionPort } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
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

function projectPath(): AbsolutePath {
  const r = AbsolutePath.parse(PROJECT_PATH);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function cwd(): AbsolutePath {
  const r = AbsolutePath.parse('/tmp/ralphctl-plan');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function approvedSprint(): Sprint {
  const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!sprint.ok) throw new Error('precondition failed');

  const tid = TicketId.parse('aaaaaaaa');
  if (!tid.ok) throw new Error('precondition failed');
  const ticket = Ticket.create({ id: tid.value, title: 'do X', projectName: projectName() });
  if (!ticket.ok) throw new Error('precondition failed');
  const approved = ticket.value.approveRequirements('must do X');
  if (!approved.ok) throw new Error('precondition failed');

  const withTicket = sprint.value.addTicket(approved.value);
  if (!withTicket.ok) throw new Error('precondition failed');
  return withTicket.value;
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toHaveLength(2);
  });

  it('passes existing tasks through to the prompt builder for replan context', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: tasksJson() } }],
    });
    const prompts = new FakePromptBuilderPort();
    const uc = new PlanSprintTasksUseCase(ai, prompts, new FakeLoggerPort());

    const sprint = approvedSprint();
    const existingResult = Task.create({
      name: 'old task',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: projectPath(),
    });
    if (!existingResult.ok) throw new Error('precondition failed');

    await uc.execute({
      sprint,
      existingTasks: [existingResult.value],
      cwd: cwd(),
    });

    expect(prompts.planCalls).toHaveLength(1);
    expect(prompts.planCalls[0]?.existingTasks).toHaveLength(1);
  });

  it('rejects a non-draft sprint with InvalidStateError', async () => {
    const sprint = approvedSprint();
    const active = sprint.activate(T0);
    if (!active.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: active.value,
      existingTasks: [],
      cwd: cwd(),
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
    const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
    if (!sprint.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');
    const ticket = Ticket.create({ id: tid.value, title: 'pending', projectName: projectName() });
    if (!ticket.ok) throw new Error('precondition failed');
    const withTicket = sprint.value.addTicket(ticket.value);
    if (!withTicket.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: withTicket.value,
      existingTasks: [],
      cwd: cwd(),
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
    const sprint = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
    if (!sprint.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: sprint.value,
      existingTasks: [],
      cwd: cwd(),
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
    }
  });

  it('task with non-existent ticketId is accepted: ticketId cross-reference is not validated here', async () => {
    // Legacy intent: document that ticketId validation is out-of-scope for this use case.
    // The use case is plan-only — it does not cross-reference ticketIds against sprint.tickets.
    // Callers are responsible for validating/linking ticketIds post-parse.
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
    });

    // The use case accepts the task — ticketId validation is intentionally out-of-scope.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toHaveLength(1);
    // The ticketId is carried through as-is (a TicketId branded string).
    expect(result.value.tasks[0]?.ticketId?.toString()).toBe(unknownTicketId);
  });

  it('propagates an AI session failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn failed' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
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
    const uc = new PlanSprintTasksUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      sprint: approvedSprint(),
      existingTasks: [],
      cwd: cwd(),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
