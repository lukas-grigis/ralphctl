/**
 * Real-git coverage for moving a sprint dir that still holds task worktrees (an interrupted run's
 * `worktrees/wt-<task>`): git records each worktree's absolute path, so the move must re-point that
 * record, or the next `git worktree prune` drops it and the worktree's work is cut off from git.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { absolutePath, makeDraftSprintBundle } from '@tests/fixtures/domain.ts';
import { recordingWriteFile } from '@tests/fixtures/recording-write-file.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { ensureCanonicalSprintDir } from '@src/integration/persistence/sprint/repository.ts';
import { toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { sprintDir, sprintsDir } from '@src/integration/persistence/storage.ts';
import { dryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import { apply } from '@src/integration/persistence/data-migration/apply.ts';

let appRoot: string;
let dataRoot: AbsolutePath;
const projects: FakeProject[] = [];

beforeEach(async () => {
  appRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-sprint-wt-')));
  dataRoot = absolutePath(join(appRoot, 'data'));
  await fs.mkdir(join(appRoot, 'state', 'locks'), { recursive: true });
  for (const sub of ['projects', 'sprints', 'memory']) await fs.mkdir(join(String(dataRoot), sub), { recursive: true });
});

afterEach(async () => {
  for (const p of projects.splice(0)) await p.cleanup();
  await fs.rm(appRoot, { recursive: true, force: true });
});

const repo = async (): Promise<FakeProject> => {
  const p = await createFakeProject();
  projects.push(p);
  return p;
};

/** A legacy bare `<id>/` sprint dir holding one worktree per repo, as an interrupted parallel run leaves it. */
const seedLegacySprintWithWorktrees = async (repos: readonly FakeProject[]) => {
  const { sprint } = makeDraftSprintBundle({ slug: 'cool-sprint' });
  const legacyDir = join(sprintsDir(dataRoot), String(sprint.id));
  await fs.mkdir(join(legacyDir, 'worktrees'), { recursive: true });
  await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonSprint(sprint)), 'utf8');
  const names = repos.map((_, i) => `wt-task-${String(i)}`);
  for (const [i, r] of repos.entries()) {
    await r.git('worktree', 'add', '-b', `ralphctl-wt/s/${String(i)}`, join(legacyDir, 'worktrees', names[i] ?? ''));
    await fs.writeFile(join(legacyDir, 'worktrees', names[i] ?? '', 'wip.txt'), 'uncommitted work\n', 'utf8');
  }
  return { sprint, legacyDir, names };
};

/** The worktree paths git still knows about after a prune — what the next implement launch sees. */
const worktreesAfterPrune = async (r: FakeProject): Promise<readonly string[]> => {
  await r.git('worktree', 'prune');
  const out = await r.git('worktree', 'list', '--porcelain');
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => p !== r.path);
};

describe.skipIf(process.platform === 'win32')('moving a sprint dir that holds worktrees', () => {
  it('the legacy-dir converge re-points every repo’s worktree record at the new path', async () => {
    const repos = [await repo(), await repo()];
    const { sprint, names } = await seedLegacySprintWithWorktrees(repos);

    const dir = await ensureCanonicalSprintDir(dataRoot, sprint.id, sprint.slug);

    expect(dir).toBe(sprintDir(dataRoot, sprint.id, sprint.slug));
    for (const [i, r] of repos.entries()) {
      expect(await worktreesAfterPrune(r)).toEqual([join(dir, 'worktrees', names[i] ?? '')]);
      expect(await r.git('-C', join(dir, 'worktrees', names[i] ?? ''), 'status', '--porcelain')).toContain('wip.txt');
    }
  });

  it('the data migration re-points the worktree record of every sprint it renames', async () => {
    const r = await repo();
    const { sprint, names } = await seedLegacySprintWithWorktrees([r]);
    const writer = recordingWriteFile();

    const report = await dryRun(dataRoot);
    const result = await apply(dataRoot, report, {
      timestamp: '2026-10-17T00:00:00.000Z',
      appVersion: '0.0.0-test',
      stateRoot: absolutePath(join(appRoot, 'state')),
      renderLearnings: () => undefined,
      mergeLearnings: () => ({ ndjson: '', md: undefined }),
      writeFile: writer.fn,
    });

    expect(result.kind).toBe('ok');
    const moved = join(sprintDir(dataRoot, sprint.id, sprint.slug), 'worktrees', names[0] ?? '');
    expect(await worktreesAfterPrune(r)).toEqual([moved]);
  });
});
