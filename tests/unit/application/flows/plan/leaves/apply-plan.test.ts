import { describe, expect, it, vi } from 'vitest';

import { applyPlanLeaf } from '@src/application/flows/plan/leaves/apply-plan.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import type { PlanCheckFinding, PlanCheckReport } from '@src/business/sprint/check-plan.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import {
  FIXED_LATER,
  makeApprovedTicket,
  makeDraftSprint,
  makePlannedSprint,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const project = makeProject();

const baseDeps = { logger: noopLogger, clock: () => FIXED_LATER };

const draftCtx = (overrides: Partial<PlanCtx> = {}): PlanCtx => {
  const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
  return {
    sprintId: sprint.id,
    projectId: project.id,
    sprint,
    project,
    tasks: [],
    proposedTasks: [makeTodoTask({ name: 'proposed' })],
    ...overrides,
  };
};

const reportWith = (findings: readonly PlanCheckFinding[]): PlanCheckReport => ({
  findings,
  errorCount: findings.length,
  warningCount: 0,
});

const graphFinding: PlanCheckFinding = { kind: 'task-graph', detail: 'task A depends on itself' };

describe('applyPlanLeaf', () => {
  it('auto-accepts and transitions the sprint when no reviewer is wired', async () => {
    const result = await applyPlanLeaf(baseDeps).execute(draftCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.sprint?.status).toBe('planned');
    expect(result.value.ctx.plannedTasks).toHaveLength(1);
    expect(result.value.ctx.tasks?.[0]?.name).toBe('proposed');
  });

  it('auto-accepts even with error-tier findings — findings never reject on the human behalf', async () => {
    const result = await applyPlanLeaf(baseDeps).execute(draftCtx({ planCheck: reportWith([graphFinding]) }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.sprint?.status).toBe('planned');
  });

  it("forwards ctx.planCheck findings as the reviewer hook's third argument", async () => {
    const review = vi.fn().mockResolvedValue({ accept: true });
    const ctx = draftCtx({ planCheck: reportWith([graphFinding]) });
    const result = await applyPlanLeaf({ ...baseDeps, reviewBeforeApprove: review }).execute(ctx);

    expect(result.ok).toBe(true);
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(ctx.proposedTasks, ctx.sprint, [graphFinding]);
  });

  it('passes an empty findings list when the check leaf produced no report', async () => {
    const review = vi.fn().mockResolvedValue({ accept: true });
    await applyPlanLeaf({ ...baseDeps, reviewBeforeApprove: review }).execute(draftCtx());

    expect(review).toHaveBeenCalledWith(expect.anything(), expect.anything(), []);
  });

  it('leaves the sprint draft and falls back to ctx.tasks when the reviewer rejects', async () => {
    const existing: readonly Task[] = [makeTodoTask({ name: 'existing' })];
    const review = vi.fn().mockResolvedValue({ accept: false });
    const result = await applyPlanLeaf({ ...baseDeps, reviewBeforeApprove: review }).execute(
      draftCtx({ tasks: existing })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.sprint?.status).toBe('draft');
    expect(result.value.ctx.plannedTasks).toBeUndefined();
    expect(result.value.ctx.tasks).toBe(existing);
  });

  it('fails with InvalidStateError when the sprint is not draft', async () => {
    const planned = makePlannedSprint();
    const result = await applyPlanLeaf(baseDeps).execute(draftCtx({ sprint: planned }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('sprint must be draft');
  });

  it('fails with InvalidStateError when ctx.proposedTasks is missing', async () => {
    const { proposedTasks: _drop, ...ctx } = draftCtx();
    void _drop;
    const result = await applyPlanLeaf(baseDeps).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('ctx.proposedTasks is undefined');
  });

  it('fails with InvalidStateError when ctx.sprint is missing', async () => {
    const { sprint: _drop, ...ctx } = draftCtx();
    void _drop;
    const result = await applyPlanLeaf(baseDeps).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('ctx.sprint is undefined');
  });
});
