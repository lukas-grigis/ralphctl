/**
 * Step-order integration test for the refine chain. Locks the trace
 * shape on happy + failure paths so the chain definition cannot drift
 * silently.
 *
 * Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
 */
import { describe, expect, it } from 'vitest';

import { abs, makeSprint, makeTicket } from '../../_test-fakes/fixtures.ts';
import { createTestDeps } from '../../_test-fakes/create-test-deps.ts';
import { createRefineFlow } from './refine-flow.ts';

const CWD = abs('/tmp/refine-test');

describe('createRefineFlow', () => {
  it('runs load-sprint → assert-draft → link-skills → refine-tickets (per-ticket: refine + save) → unlink-skills', async () => {
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
      cwd: CWD,
      pendingTickets: sprint1.value.tickets,
    });

    const result = await flow.execute({ sprintId: sprint1.value.id, cwd: CWD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toEqual([
      'load-sprint',
      'assert-draft',
      'link-skills',
      `refine-${ticket.id}`,
      `save-after-${ticket.id}`,
      'unlink-skills',
    ]);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    // Sprint should have been persisted with the approved ticket.
    const reread = await deps.sprintRepo.findById(sprint1.value.id);
    if (!reread.ok) throw new Error('expected sprint after run');
    const updated = reread.value.ticketById(ticket.id);
    expect(updated?.requirementStatus).toBe('approved');
  });

  it('step short-circuit: mid-chain failure marks remaining steps as "skipped"', async () => {
    // assert-draft fails → link-skills, refine-tickets, unlink-skills all skipped.
    const sprint0 = makeSprint();
    const activated = sprint0.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition failed');

    const deps = createTestDeps({ sprints: [activated.value] });
    const flow = createRefineFlow(deps, {
      sprintId: activated.value.id,
      cwd: CWD,
      pendingTickets: [],
    });

    const result = await flow.execute({ sprintId: activated.value.id, cwd: CWD });
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
      cwd: CWD,
      pendingTickets: sprint1.value.tickets,
    });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint1.value.id, cwd: CWD }, ac.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('short-circuits at assert-draft when the sprint is not draft', async () => {
    const sprint0 = makeSprint();
    // Activate the sprint to break the precondition.
    const activated = sprint0.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition failed');

    const deps = createTestDeps({ sprints: [activated.value] });

    const flow = createRefineFlow(deps, {
      sprintId: activated.value.id,
      cwd: CWD,
      pendingTickets: [],
    });

    const result = await flow.execute({ sprintId: activated.value.id, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('invalid-state');
    const trace = result.error.trace.map((t) => t.stepName);
    // load-sprint completed, assert-draft failed, the rest skipped.
    expect(trace.slice(0, 2)).toEqual(['load-sprint', 'assert-draft']);
    expect(result.error.trace[1]?.status).toBe('failed');
    expect(trace.slice(2)).toEqual(['link-skills', 'refine-tickets', 'unlink-skills']);
    for (const entry of result.error.trace.slice(2)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('short-circuits inside refine-tickets when the AI session fails for the first ticket', async () => {
    const sprint0 = makeSprint();
    const t1 = makeTicket({ title: 'A' });
    const t2 = makeTicket({ title: 'B' });
    const withT1 = sprint0.addTicket(t1);
    if (!withT1.ok) throw new Error('precondition');
    const withBoth = withT1.value.addTicket(t2);
    if (!withBoth.ok) throw new Error('precondition');

    const aiError = new (await import('../../../domain/errors/storage-error.ts')).StorageError({
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
      cwd: CWD,
      pendingTickets: withBoth.value.tickets,
    });

    const result = await flow.execute({ sprintId: withBoth.value.id, cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const stepNames = result.error.trace.map((t) => t.stepName);
    // The first refine-<id> failed, save-after-<id> is skipped, the
    // second per-ticket sub-chain is also skipped, and unlink-skills
    // is skipped.
    expect(stepNames).toContain('load-sprint');
    expect(stepNames).toContain('assert-draft');
    expect(stepNames).toContain('link-skills');
    expect(stepNames).toContain(`refine-${t1.id}`);
    expect(stepNames).toContain(`save-after-${t1.id}`);
    // unlink-skills did not run.
    const lastRunningStep = result.error.trace.find((t) => t.stepName === `refine-${t1.id}`);
    expect(lastRunningStep?.status).toBe('failed');
  });
});
