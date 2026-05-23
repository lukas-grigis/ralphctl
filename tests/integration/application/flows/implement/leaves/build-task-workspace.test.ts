import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
import type { VerificationCriterion } from '@src/domain/entity/task.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

describe('buildTaskWorkspaceLeaf', () => {
  let dir: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-workspace-'));
    dir = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const buildLeaf = (task = makeTodoTask({ name: 'demo-task' })) => {
    const sprintDir = absolutePath(dir);
    const cwd = absolutePath(dir);
    const progressFile = absolutePath(join(dir, 'progress.md'));
    const leaf = buildTaskWorkspaceLeaf(
      { templateLoader: createFsTemplateLoader(defaultTemplatesDir()), logger: noopLogger },
      { sprintDir, cwd, progressFile },
      task.id
    );
    return { leaf, task, sprintDir };
  };

  it('writes prompt.md + contract.md with structured criteria and no done-criteria.md', async () => {
    const base = makeTodoTask({ name: 'add-feature' });
    const task = {
      ...base,
      verificationCriteria: [
        { id: 'C1', assertion: 'TypeScript compiles', check: 'auto', command: 'npm run typecheck' },
        { id: 'C2', assertion: 'New tests pass', check: 'manual' },
      ] as readonly VerificationCriterion[],
    };
    const { leaf } = buildLeaf(task);

    const result = await leaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
    } satisfies ImplementCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = join(dir, 'implement', String(task.id));
    const prompt = await fs.readFile(join(root, 'prompt.md'), 'utf8');

    expect(prompt).toContain('add-feature');
    expect(prompt).toContain('progress.md');
    // Criteria render under a stable heading so operators can grep.
    expect(prompt).toContain('**[C1]** (auto) `npm run typecheck` — TypeScript compiles');
    expect(prompt).toContain('**[C2]** (manual) — New tests pass');
    // The contract sidecar carries the canonical table; the implementer prompt cites its path.
    const contract = await fs.readFile(join(root, 'contract.md'), 'utf8');
    expect(contract).toContain('# add-feature');
    expect(contract).toContain('| C1 | auto | `npm run typecheck` | TypeScript compiles |');
    expect(contract).toContain('| C2 | manual | — | New tests pass |');
    expect(prompt).toContain(join(root, 'contract.md'));
    // Audit [05] deletion: the standalone file is gone.
    await expect(fs.access(join(root, 'done-criteria.md'))).rejects.toThrow();
    expect(result.value.ctx.taskWorkspaceRoot).toBe(root);
  });

  it('overwrites prompt.md + contract.md on re-run (derived from current task spec)', async () => {
    const base = makeTodoTask({ name: 'v1-name' });
    const task = {
      ...base,
      verificationCriteria: [
        { id: 'C1', assertion: 'old criterion', check: 'manual' },
      ] as readonly VerificationCriterion[],
    };
    const root = join(dir, 'implement', String(task.id));

    const { leaf: firstLeaf } = buildLeaf(task);
    await firstLeaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
    } satisfies ImplementCtx);
    expect(await fs.readFile(join(root, 'prompt.md'), 'utf8')).toContain('old criterion');
    expect(await fs.readFile(join(root, 'contract.md'), 'utf8')).toContain('old criterion');

    const editedTask = {
      ...task,
      name: 'v2-name',
      verificationCriteria: [
        { id: 'C1', assertion: 'fresh criterion', check: 'manual' },
      ] as readonly VerificationCriterion[],
    };
    const { leaf: secondLeaf } = buildLeaf(editedTask);
    await secondLeaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [editedTask],
    } satisfies ImplementCtx);

    const promptAfter = await fs.readFile(join(root, 'prompt.md'), 'utf8');
    const contractAfter = await fs.readFile(join(root, 'contract.md'), 'utf8');
    expect(promptAfter).toContain('v2-name');
    expect(promptAfter).not.toContain('v1-name');
    expect(promptAfter).toContain('fresh criterion');
    expect(promptAfter).not.toContain('old criterion');
    expect(contractAfter).toContain('# v2-name');
    expect(contractAfter).toContain('fresh criterion');
    expect(contractAfter).not.toContain('old criterion');
  });

  it('fails fast when ctx.tasks does not contain the task', async () => {
    const task = makeTodoTask();
    const { leaf } = buildLeaf(task);

    const result = await leaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [],
    } satisfies ImplementCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.message).toMatch(/task not found/);
    }
  });
});
