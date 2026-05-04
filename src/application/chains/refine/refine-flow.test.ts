/**
 * Step-order integration test for the refine chain. Locks the trace
 * shape on happy + failure paths so the chain definition cannot drift
 * silently.
 */
import { describe, expect, it } from 'vitest';

import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { makeSprint, makeTicket } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createRefineFlow } from './refine-flow.ts';

describe('createRefineFlow', () => {
  it('runs load-sprint → assert-draft → refine-tickets (per-ticket: stage-ticket → build-refinement-unit → link-skills → render-prompt-to-file → refine-<id> → unlink-skills → save-after-<id> → export-sprint-requirements)', async () => {
    const sprint0 = makeSprint();
    const ticket = makeTicket({ title: 'A' });
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error(sprint1.error.message);

    const deps = createTestDeps({
      sprints: [sprint1.value],
      aiSession: {
        outcomes: [{ kind: 'ok', result: { output: 'requirements: do the thing' } }],
      },
    });

    const flow = createRefineFlow(deps, {
      sprintId: sprint1.value.id,
      pendingTickets: sprint1.value.tickets,
    });

    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-draft',
      'stage-ticket',
      'build-refinement-unit',
      'link-skills',
      'render-prompt-to-file',
      `refine-${ticket.id}`,
      'unlink-skills',
      `save-after-${ticket.id}`,
      'export-sprint-requirements',
    ]);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    const reread = await deps.sprintRepo.findById(sprint1.value.id);
    if (!reread.ok) throw new Error('expected sprint after run');
    const updated = reread.value.ticketById(ticket.id);
    expect(updated?.requirementStatus).toBe('approved');
  });

  it('step short-circuit: mid-chain failure marks remaining steps as "skipped"', async () => {
    const sprint0 = makeSprint();
    const activated = sprint0.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition failed');

    const deps = createTestDeps({ sprints: [activated.value] });
    const flow = createRefineFlow(deps, {
      sprintId: activated.value.id,
      pendingTickets: [],
    });

    const result = await flow.execute({ sprintId: activated.value.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(failedIdx).toBeGreaterThan(-1);
    for (const entry of result.error.trace.slice(failedIdx + 1)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and chain fails', async () => {
    const sprint0 = makeSprint();
    const ticket = makeTicket({ title: 'A' });
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');

    const deps = createTestDeps({ sprints: [sprint1.value] });
    const flow = createRefineFlow(deps, {
      sprintId: sprint1.value.id,
      pendingTickets: sprint1.value.tickets,
    });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint1.value.id }, ac.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('short-circuits at assert-draft when the sprint is not draft', async () => {
    const sprint0 = makeSprint();
    const activated = sprint0.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition failed');

    const deps = createTestDeps({ sprints: [activated.value] });

    const flow = createRefineFlow(deps, {
      sprintId: activated.value.id,
      pendingTickets: [],
    });

    const result = await flow.execute({ sprintId: activated.value.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('invalid-state');
    const trace = result.error.trace.map((t) => t.stepName);
    expect(trace.slice(0, 2)).toStrictEqual(['load-sprint', 'assert-draft']);
    expect(result.error.trace[1]?.status).toBe('failed');
    expect(trace.slice(2)).toStrictEqual(['refine-tickets']);
    for (const entry of result.error.trace.slice(2)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('aborts when the session-folder builder fails for the first ticket', async () => {
    const sprint0 = makeSprint();
    const ticket = makeTicket({ title: 'A' });
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error(sprint1.error.message);

    const failure = new StorageError({ subCode: 'io', message: 'cannot create unit folder' });
    const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ failWith: failure });
    const deps = createTestDeps({
      sprints: [sprint1.value],
      overrides: { sessionFolderBuilder },
    });

    const flow = createRefineFlow(deps, {
      sprintId: sprint1.value.id,
      pendingTickets: sprint1.value.tickets,
    });

    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.message).toBe('cannot create unit folder');

    const trace = result.error.trace.map((t) => t.stepName);
    // Build-refinement-unit fails inside the per-ticket chain → link-skills,
    // render, refine-<id>, unlink-skills, save-after-<id> all skipped.
    expect(trace.slice(0, 4)).toStrictEqual(['load-sprint', 'assert-draft', 'stage-ticket', 'build-refinement-unit']);
    expect(result.error.trace[3]?.status).toBe('failed');
    for (const entry of result.error.trace.slice(4)) {
      expect(entry.status).toBe('skipped');
    }
    const linkEntry = result.error.trace.find((t) => t.stepName === 'link-skills');
    expect(linkEntry?.status).toBe('skipped');
  });

  it('short-circuits inside refine-tickets when the AI session fails for the first ticket', async () => {
    const sprint0 = makeSprint();
    const t1 = makeTicket({ title: 'A' });
    const t2 = makeTicket({ title: 'B' });
    const withT1 = sprint0.addTicket(t1);
    if (!withT1.ok) throw new Error('precondition');
    const withBoth = withT1.value.addTicket(t2);
    if (!withBoth.ok) throw new Error('precondition');

    const aiError = new (await import('@src/domain/errors/storage-error.ts')).StorageError({
      subCode: 'io',
      message: 'kaboom',
    });

    const deps = createTestDeps({
      sprints: [withBoth.value],
      aiSession: {
        outcomes: [{ kind: 'error', error: aiError }],
      },
    });

    const flow = createRefineFlow(deps, {
      sprintId: withBoth.value.id,
      pendingTickets: withBoth.value.tickets,
    });

    const result = await flow.execute({ sprintId: withBoth.value.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const stepNames = result.error.trace.map((t) => t.stepName);
    expect(stepNames).toContain('load-sprint');
    expect(stepNames).toContain('assert-draft');
    expect(stepNames).toContain(`refine-${t1.id}`);
    const lastRunningStep = result.error.trace.find((t) => t.stepName === `refine-${t1.id}`);
    expect(lastRunningStep?.status).toBe('failed');
  });
});
