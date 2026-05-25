import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath, FIXED_LATER, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  stampEvaluatorRoleMetaLeaf,
  stampGeneratorRoleMetaLeaf,
} from '@src/application/flows/implement/leaves/stamp-role-meta.ts';

/**
 * Helper — read and parse the `role-meta.json` file the leaf wrote so assertions name the
 * JSON fields directly rather than carrying around raw text. Centralised so the path layout
 * (`<workspaceRoot>/rounds/<N>/<role>/role-meta.json`) is asserted in one place.
 */
const readRoleMeta = async (
  workspaceRoot: string,
  roundN: number,
  role: 'generator' | 'evaluator'
): Promise<unknown> => {
  const path = join(workspaceRoot, 'rounds', String(roundN), role, 'role-meta.json');
  return JSON.parse(await fs.readFile(path, 'utf8'));
};

describe('stampGeneratorRoleMetaLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await root.cleanup();
  });

  it('writes rounds/<N>/generator/role-meta.json with provider/model/effort/attempt/round/timestamp', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7', effort: 'high' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
    } satisfies ImplementCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await readRoleMeta(String(root.root), 1, 'generator');
    // Whole-object equality — the role-meta.json shape is the contract; missing or extra
    // keys are a bug, not a stylistic preference. Keeping this exact catches an accidental
    // field rename downstream.
    expect(meta).toEqual({
      role: 'generator',
      provider: 'claude-code',
      model: 'claude-opus-4-7',
      effort: 'high',
      attemptN: 1,
      roundN: 1,
      startedAt: FIXED_LATER,
      escalatedFromModel: null,
    });

    // Pure write leaf — must not mutate ctx (round numbering is owned upstream by
    // `resolveRoundNumLeaf`, which set `currentRoundNum` before this leaf ran).
    expect(result.value.ctx.currentRoundNum).toBe(1);
  });

  it('emits effort = null when the leaf was given no effort override', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'github-copilot', model: 'gpt-5-mini' }, // no effort
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
    });
    expect(result.ok).toBe(true);

    const meta = (await readRoleMeta(String(root.root), 1, 'generator')) as { effort: unknown };
    // `null`, not `undefined` — JSON has no `undefined`, and absence would be ambiguous with
    // "field never written"; the leaf chooses the explicit-null contract.
    expect(meta.effort).toBeNull();
  });

  it('mirrors escalatedFromModel when the task has been escalated', async () => {
    const base = makeInProgressTaskWithRunningAttempt();
    // Mutate the in-progress task to look post-escalation; equivalent to what the
    // `finalize-gen-eval` leaf stamps on first-plateau.
    const escalated = { ...base, escalatedFromModel: 'claude-haiku-3-5', escalatedToModel: 'claude-sonnet-4-6' };
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-sonnet-4-6' },
      base.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [escalated],
      currentTask: escalated,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
    });
    expect(result.ok).toBe(true);

    const meta = (await readRoleMeta(String(root.root), 1, 'generator')) as { escalatedFromModel: unknown };
    expect(meta.escalatedFromModel).toBe('claude-haiku-3-5');
  });

  it('writes under the round number set by ctx.currentRoundNum (resume safety lives in resolve-round-num)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7' },
      task.id
    );

    // Simulate `resolveRoundNumLeaf` having claimed N=3 from a resumed sprint dir.
    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 3,
    });
    expect(result.ok).toBe(true);

    const meta = (await readRoleMeta(String(root.root), 3, 'generator')) as { roundN: number };
    expect(meta.roundN).toBe(3);
  });

  it('writes atomically — no leftover .tmp file after a clean write', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7' },
      task.id
    );
    await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
    });

    const dir = join(String(root.root), 'rounds', '1', 'generator');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('role-meta.json');
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('surfaces a write failure as a chain-level error (audit trail must be complete or absent)', async () => {
    // Failing WriteFile fake — the leaf must NOT swallow the failure; missing attribution
    // on a working spawn is misleading, so the chain halts instead.
    const failingWrite: WriteFile = async () => Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: failingWrite, clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.message).toContain('disk full');
  });

  it('throws InvalidStateError when ctx.taskWorkspaceRoot is missing (chain-construction bug)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      // taskWorkspaceRoot omitted on purpose
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.message).toContain('taskWorkspaceRoot');
  });

  it('throws InvalidStateError when ctx.currentRoundNum is missing (resolve-round-num must run first)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampGeneratorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_LATER, logger: noopLogger },
      { provider: 'claude-code', model: 'claude-opus-4-7' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      // currentRoundNum omitted — chain-construction error.
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.message).toContain('currentRoundNum');
  });
});

describe('stampEvaluatorRoleMetaLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await root.cleanup();
  });

  it('writes rounds/<N>/evaluator/role-meta.json from ctx.currentRoundNum (set by resolve-round-num)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampEvaluatorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_NOW, logger: noopLogger },
      { provider: 'openai-codex', model: 'gpt-5.5', effort: 'medium' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      currentRoundNum: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await readRoleMeta(String(root.root), 2, 'evaluator');
    expect(meta).toEqual({
      role: 'evaluator',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      effort: 'medium',
      attemptN: 1,
      roundN: 2,
      startedAt: FIXED_NOW,
      escalatedFromModel: null,
    });

    // Pure write leaf — must not mutate ctx.
    expect(result.value.ctx.currentRoundNum).toBe(2);
  });

  it('throws InvalidStateError when ctx.currentRoundNum is missing (resolve-round-num must run first)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leafEl = stampEvaluatorRoleMetaLeaf(
      { writeFile: createAtomicWriteFile(), clock: () => FIXED_NOW, logger: noopLogger },
      { provider: 'openai-codex', model: 'gpt-5.5' },
      task.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      // currentRoundNum omitted — chain-construction error.
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.message).toContain('currentRoundNum');
  });

  // Sanity guard — the absolutePath fixture is used so the typecheck side knows the
  // generic AbsolutePath flow works in this test file.
  it('the test fixture absolutePath helper returns a typed root', () => {
    expect(typeof absolutePath('/tmp/probe')).toBe('string');
  });
});
