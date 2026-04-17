import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestEnv, type TestEnvironment } from '@src/test-utils/setup.ts';
import { writeEvaluation } from './evaluation.ts';

let env: TestEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = env.testDir;
  // Pre-create the sprint directory so the sidecar write has a parent
  await mkdir(join(env.testDir, 'sprints', '20240101-120000-test'), { recursive: true });
});

afterEach(async () => {
  await env.cleanup();
  delete process.env['RALPHCTL_ROOT'];
});

describe('writeEvaluation', () => {
  const sprintId = '20240101-120000-test';
  const taskId = 'task-001';

  it('writes a sidecar file at <sprint>/evaluations/<taskId>.md', async () => {
    const filePath = await writeEvaluation(sprintId, taskId, 1, 'passed', 'Looks good.');
    expect(filePath).toBe(join(env.testDir, 'sprints', sprintId, 'evaluations', `${taskId}.md`));
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('Iteration 1');
    expect(content).toContain('PASSED');
    expect(content).toContain('Looks good.');
  });

  it('appends successive iterations to the same file', async () => {
    await writeEvaluation(sprintId, taskId, 1, 'failed', 'First iteration critique');
    await writeEvaluation(sprintId, taskId, 2, 'passed', 'Second iteration: fixed');
    const filePath = join(env.testDir, 'sprints', sprintId, 'evaluations', `${taskId}.md`);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('Iteration 1');
    expect(content).toContain('FAILED');
    expect(content).toContain('First iteration critique');
    expect(content).toContain('Iteration 2');
    expect(content).toContain('PASSED');
    expect(content).toContain('Second iteration: fixed');
  });

  it('preserves the full critique without truncation', async () => {
    const longBody = 'x'.repeat(8000);
    await writeEvaluation(sprintId, taskId, 1, 'failed', longBody);
    const filePath = join(env.testDir, 'sprints', sprintId, 'evaluations', `${taskId}.md`);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain(longBody);
  });

  it('rejects taskIds containing path traversal', async () => {
    await expect(writeEvaluation(sprintId, '../escape', 1, 'passed', 'oops')).rejects.toThrow(/Path traversal/);
  });

  it('records status in the header for the malformed case', async () => {
    await writeEvaluation(sprintId, taskId, 1, 'malformed', 'Evaluator output had no parseable signal');
    const filePath = join(env.testDir, 'sprints', sprintId, 'evaluations', `${taskId}.md`);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('MALFORMED');
  });
});
