/**
 * `buildExecutionUnit` integration tests — covers the `done-criteria.md`
 * copy and the renamed `prior-evaluations/` subtree.
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
import { TaskId } from '@src/domain/values/task-id.ts';
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

describe('buildExecutionUnit — prior-evaluations directory', () => {
  it('writes prior sibling critiques to <unit>/prior-evaluations/<task-id>.md (renamed from evaluations/)', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'current task', projectPath: '/tmp' });
    const priorId = TaskId.trustString('aaaaaaaa');
    const priorBody = '# Prior critique\n\n- correctness PASS';

    const storage = resolveStoragePaths();
    const result = await buildExecutionUnit(storage, {
      sprint,
      tasks: [task],
      task,
      aiProvider: 'claude',
      priorEvaluations: new Map([[priorId, priorBody]]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unitRoot = String(result.value.root);
    // The renamed folder receives prior siblings.
    const priorPath = join(unitRoot, 'prior-evaluations', `${String(priorId)}.md`);
    const body = await readFile(priorPath, 'utf-8');
    expect(body).toContain('Prior critique');
    expect(body).toContain('correctness PASS');

    // The legacy `evaluations/` folder must NOT exist.
    await expect(stat(join(unitRoot, 'evaluations'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
