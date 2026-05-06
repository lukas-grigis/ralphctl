/**
 * `buildExecutionUnit` integration tests — covers the `done-criteria.md`
 * copy and the inline rendering of sibling evaluator output inside
 * `tasks.md`.
 *
 * `buildExecutionUnit` is an IO-heavy function — these tests write to a real
 * tmp directory. Each test gets its own isolated root via a unique prefix.
 */
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStoragePaths, resetEnsureLayoutDirsCache } from '@src/integration/persistence/storage-paths.ts';
import { makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { buildExecutionUnit } from './execution-unit-builder.ts';

function uniqueRoot(): string {
  return join(
    tmpdir(),
    `ralphctl-exec-unit-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

let testRoot: string;

beforeEach(() => {
  testRoot = uniqueRoot();
  process.env['RALPHCTL_ROOT'] = testRoot;
  resetEnsureLayoutDirsCache();
});

afterEach(() => {
  delete process.env['RALPHCTL_ROOT'];
  resetEnsureLayoutDirsCache();
});

describe('buildExecutionUnit — done-criteria.md', () => {
  it('copies done-criteria.md from the sprint dir into the execution unit root', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'Wire login', projectPath: '/tmp' });

    // Pre-write a done-criteria.md in the sprint dir.
    const storage = resolveStoragePaths();
    const sprintDir = String(storage.sprintDir(sprint.id));
    await mkdir(sprintDir, { recursive: true });
    const criteriaContent = `# Done criteria\n\n- **Wire login** (\`${String(task.id)}\`) — Login redirects work\n`;
    await writeFile(String(storage.doneCriteriaFile(sprint.id)), criteriaContent, 'utf-8');

    const result = await buildExecutionUnit(storage, {
      sprint,
      tasks: [task],
      task,
      aiProvider: 'claude',
      priorEvaluations: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unitRoot = String(result.value.root);
    const copiedPath = join(unitRoot, 'done-criteria.md');
    const body = await readFile(copiedPath, 'utf-8');
    expect(body).toContain('Wire login');
    expect(body).toContain(String(task.id));
  });

  it('proceeds without error when done-criteria.md is absent (legacy sprint)', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'Legacy task', projectPath: '/tmp' });

    const storage = resolveStoragePaths();
    // Do NOT write done-criteria.md — simulate a legacy sprint.

    const warnings: string[] = [];
    const result = await buildExecutionUnit(storage, {
      sprint,
      tasks: [task],
      task,
      aiProvider: 'claude',
      priorEvaluations: new Map(),
      onWarn: (msg) => {
        warnings.push(msg);
      },
    });

    // Build must succeed despite missing criteria file.
    expect(result.ok).toBe(true);
    // A warning must be emitted so callers can surface it.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('done-criteria.md not found');
  });
});

describe('buildExecutionUnit — tasks.md inline prior evaluations', () => {
  it('renders sibling evaluator output as a fenced ### Evaluator output block inside tasks.md', async () => {
    const sprint = makeSprint();
    // The current task is the one under review; the sibling carries the
    // prior evaluation that should surface inside `tasks.md`.
    const sibling = makeTask({ name: 'sibling task', projectPath: '/tmp', order: 1 });
    const current = makeTask({ name: 'current task', projectPath: '/tmp', order: 2 });
    const priorBody = '# Prior critique\n\n- correctness PASS';

    const storage = resolveStoragePaths();
    const result = await buildExecutionUnit(storage, {
      sprint,
      tasks: [sibling, current],
      task: current,
      aiProvider: 'claude',
      priorEvaluations: new Map([[sibling.id, priorBody]]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unitRoot = String(result.value.root);
    const tasksMd = await readFile(join(unitRoot, 'tasks.md'), 'utf-8');
    // Sibling section carries the verdict heading + fenced body.
    expect(tasksMd).toContain('## 1. sibling task');
    expect(tasksMd).toContain('### Evaluator output');
    expect(tasksMd).toContain('```text');
    expect(tasksMd).toContain('Prior critique');
    expect(tasksMd).toContain('correctness PASS');

    // Per-unit tasks.json is gone — only the canonical sprint-root copy
    // remains (untouched by this builder).
    await expect(stat(join(unitRoot, 'tasks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Per-unit prior-evaluations/ directory is gone too.
    await expect(stat(join(unitRoot, 'prior-evaluations'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('omits the ### Evaluator output heading for tasks without a prior evaluation', async () => {
    const sprint = makeSprint();
    const onlyTask = makeTask({ name: 'lonely task', projectPath: '/tmp' });

    const storage = resolveStoragePaths();
    const result = await buildExecutionUnit(storage, {
      sprint,
      tasks: [onlyTask],
      task: onlyTask,
      aiProvider: 'claude',
      priorEvaluations: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unitRoot = String(result.value.root);
    const tasksMd = await readFile(join(unitRoot, 'tasks.md'), 'utf-8');
    expect(tasksMd).toContain('## 1. lonely task');
    expect(tasksMd).not.toContain('### Evaluator output');

    // Per-unit tasks.json is gone unconditionally.
    await expect(stat(join(unitRoot, 'tasks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
