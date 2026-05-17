import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
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

  it('writes prompt.md and done-criteria.md into implement/<task-id>/', async () => {
    const base = makeTodoTask({ name: 'add-feature' });
    const task = { ...base, verificationCriteria: ['TypeScript compiles', 'New tests pass'] as const };
    const { leaf } = buildLeaf(task);

    const result = await leaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
    } satisfies ImplementCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = join(dir, 'implement', String(task.id));
    const prompt = await fs.readFile(join(root, 'prompt.md'), 'utf8');
    const criteria = await fs.readFile(join(root, 'done-criteria.md'), 'utf8');

    expect(prompt).toContain('add-feature');
    expect(prompt).toContain('progress.md');
    expect(criteria).toContain('TypeScript compiles');
    expect(criteria).toContain('New tests pass');
    expect(result.value.ctx.taskWorkspaceRoot).toBe(root);
  });

  it('renders a placeholder line when the task has no verification criteria', async () => {
    const base = makeTodoTask({ name: 'no-criteria-task' });
    const task = { ...base, verificationCriteria: [] as readonly string[] };
    const { leaf } = buildLeaf(task);

    const result = await leaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
    } satisfies ImplementCtx);

    expect(result.ok).toBe(true);
    const criteria = await fs.readFile(join(dir, 'implement', String(task.id), 'done-criteria.md'), 'utf8');
    expect(criteria).toContain('No verification criteria declared');
  });

  it('overwrites prompt.md and done-criteria.md on re-run (derived files refresh from current spec)', async () => {
    const base = makeTodoTask({ name: 'v1-name' });
    const task = { ...base, verificationCriteria: ['old criterion'] as readonly string[] };
    const root = join(dir, 'implement', String(task.id));

    const { leaf: firstLeaf } = buildLeaf(task);
    await firstLeaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
    } satisfies ImplementCtx);
    expect(await fs.readFile(join(root, 'done-criteria.md'), 'utf8')).toContain('old criterion');

    const editedTask = { ...task, name: 'v2-name', verificationCriteria: ['fresh criterion'] as readonly string[] };
    const { leaf: secondLeaf } = buildLeaf(editedTask);
    await secondLeaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [editedTask],
    } satisfies ImplementCtx);

    const promptAfter = await fs.readFile(join(root, 'prompt.md'), 'utf8');
    const criteriaAfter = await fs.readFile(join(root, 'done-criteria.md'), 'utf8');
    expect(promptAfter).toContain('v2-name');
    expect(promptAfter).not.toContain('v1-name');
    expect(criteriaAfter).toContain('fresh criterion');
    expect(criteriaAfter).not.toContain('old criterion');
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
