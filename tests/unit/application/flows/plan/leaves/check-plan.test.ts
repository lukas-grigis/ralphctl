import { describe, expect, it } from 'vitest';

import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import { checkPlanLeaf } from '@src/application/flows/plan/leaves/check-plan.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { makeDraftSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

interface Record_ {
  readonly level: 'warn' | 'debug';
  readonly message: string;
  readonly meta?: LogMeta;
}

const recordingLogger = (): { logger: Logger; records: readonly Record_[] } => {
  const records: Record_[] = [];
  const logger: Logger = {
    debug(message, meta) {
      records.push({ level: 'debug', message, ...(meta !== undefined ? { meta } : {}) });
    },
    info() {},
    warn(message, meta) {
      records.push({ level: 'warn', message, ...(meta !== undefined ? { meta } : {}) });
    },
    error() {},
    named() {
      return logger;
    },
  };
  return { logger, records };
};

const withCriteria = (criteria: readonly VerificationCriterion[]): TodoTask => ({
  ...makeTodoTask(),
  verificationCriteria: criteria,
});

const project = makeProject();
const sprint = makeDraftSprint();

const ctxWith = (proposedTasks: readonly TodoTask[]): PlanCtx => ({
  sprintId: sprint.id,
  projectId: project.id,
  sprint,
  project,
  proposedTasks,
});

describe('checkPlanLeaf', () => {
  it('writes the report onto ctx.planCheck and completes on a clean plan', async () => {
    const { logger, records } = recordingLogger();
    const result = await checkPlanLeaf({ logger }).execute(ctxWith([makeTodoTask()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.planCheck?.findings).toEqual([]);
    expect(result.value.trace[0]?.status).toBe('completed');
    expect(records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  it('completes (never fails) even with error-tier findings, and logs one warn per finding', async () => {
    const { logger, records } = recordingLogger();
    const task = withCriteria([
      { id: 'C1', assertion: 'it works', check: 'auto' },
      { id: 'C1', assertion: 'it still works', check: 'manual' },
    ]);
    const result = await checkPlanLeaf({ logger }).execute(ctxWith([task]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.ctx.planCheck;
    expect(report?.errorCount).toBe(1);
    expect(report?.warningCount).toBe(1);

    const warns = records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(2);
    expect(warns.map((r) => r.meta?.kind)).toEqual(['auto-criterion-missing-command', 'duplicate-criterion-id']);
    expect(warns.map((r) => r.meta?.severity)).toEqual(['error', 'warning']);
    expect(warns[0]?.message).toContain('error:');
    // Advisory only — an error-tier finding must not fail the leaf.
    expect(result.value.trace[0]?.status).toBe('completed');
  });

  it('fails with InvalidStateError when ctx.proposedTasks is missing', async () => {
    const { logger } = recordingLogger();
    const { proposedTasks: _drop, ...ctx } = ctxWith([]);
    void _drop;
    const result = await checkPlanLeaf({ logger }).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('ctx.proposedTasks is undefined');
  });

  it('fails with InvalidStateError when ctx.project is missing', async () => {
    const { logger } = recordingLogger();
    const { project: _drop, ...ctx } = ctxWith([makeTodoTask()]);
    void _drop;
    const result = await checkPlanLeaf({ logger }).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('ctx.project is undefined');
  });
});
