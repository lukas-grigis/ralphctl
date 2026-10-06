/**
 * Real-git coverage for moving a leftover worktree ref aside instead of force-deleting it: a ref
 * holding commits the sprint branch lacks must survive under `ralphctl-rescue/`, while a ref whose
 * commits already landed (directly or through a cherry-pick fold) is deleted as before.
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitWorktreeRef, legacyGitWorktreeRef } from '@src/integration/io/git-operations.ts';
import { gitRescueRef, gitUniqueCommitCount } from '@src/integration/io/git-ref-rescue.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { createFoldQueue, type BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';
import { settleStaleWorktreeRefs } from '@src/application/flows/implement/worktree-stale-refs.ts';
import { absolutePath, FIXED_LATER, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const sprintId = makePlannedSprint().id;
const task = makeTodoTask({ name: 'rescue me' });
const REF = gitWorktreeRef(String(sprintId), String(task.id));
const LEGACY = legacyGitWorktreeRef(String(sprintId), String(task.id));
const RESCUE = gitRescueRef(String(sprintId), String(task.id), FIXED_LATER);

describe('worktree ref rescue (real git)', () => {
  let project: FakeProject;
  let root: AbsolutePath;
  let events: AppEvent[];
  let appended: string[];

  const deps = (): BuildWaveBranchesDeps => {
    const appendFile: AppendFile = async (_path, text) => {
      appended.push(text);
      return Result.ok(undefined);
    };
    const eventBus = { publish: (e: AppEvent) => events.push(e), subscribe: () => () => {} };
    return {
      implement: {
        gitRunner: createGitRunner(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        appendFile,
        journalMutex: createFoldQueue(),
      } as unknown as ImplementDeps,
      eventBus,
      foldQueue: createFoldQueue(),
    };
  };

  const settle = (refs: readonly string[], checkedOut: ReadonlySet<string> = new Set()) =>
    settleStaleWorktreeRefs(
      deps(),
      { repoRoot: root, sprintId, taskId: task.id, taskName: task.name, progressFile: absolutePath('/x/progress.md') },
      refs,
      checkedOut
    );

  /** Branch `ref` off main with one commit main lacks; returns that commit's SHA. */
  const refWithUniqueCommit = async (ref: string, file = 'work.txt'): Promise<string> => {
    await project.git('checkout', '-q', '-b', ref);
    await project.writeFile(file, 'verified work\n');
    await project.git('add', file);
    await project.git('commit', '-q', '-m', `feat: ${file}`);
    const sha = (await project.git('rev-parse', 'HEAD')).trim();
    await project.git('checkout', '-q', 'main');
    return sha;
  };

  const refExists = async (ref: string): Promise<boolean> =>
    project.git('show-ref', '--verify', '--quiet', `refs/heads/${ref}`).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    project = await createFakeProject();
    root = absolutePath(project.path);
    events = [];
    appended = [];
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('moves a ref with unique commits under ralphctl-rescue/ — the commits survive', async () => {
    const sha = await refWithUniqueCommit(REF);

    const result = await settle([REF]);

    expect(result.ok).toBe(true);
    expect(await refExists(REF)).toBe(false);
    expect((await project.git('rev-parse', RESCUE)).trim()).toBe(sha);
    expect(await project.git('show', `${RESCUE}:work.txt`)).toBe('verified work\n');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'banner-show',
        id: `ref-rescued-${String(task.id)}`,
        tier: 'warn',
        message: `kept 1 unlanded commit(s) of "rescue me" as ${RESCUE} — cherry-pick to recover`,
      })
    );
    expect(appended).toEqual([
      `\n_Task rescue me: 1 verified commit(s) on \`${REF}\` were not on the sprint branch — moved to \`${RESCUE}\` (recover with \`git cherry-pick\`)._\n`,
    ]);
  });

  it('deletes a ref whose commits the sprint branch already has', async () => {
    await project.git('branch', REF);

    const result = await settle([REF]);

    expect(result.ok).toBe(true);
    expect(await refExists(REF)).toBe(false);
    expect(await refExists(RESCUE)).toBe(false);
    expect(events).toEqual([]);
  });

  it('deletes a ref whose commit landed through a cherry-pick fold (new SHA, same patch)', async () => {
    const sha = await refWithUniqueCommit(REF);
    await project.writeFile('other.txt', 'sibling\n');
    await project.git('add', 'other.txt');
    await project.git('commit', '-q', '-m', 'feat: sibling folded first');
    await project.git('cherry-pick', sha);

    expect(await gitUniqueCommitCount(createGitRunner(), root, 'HEAD', REF)).toEqual(Result.ok(0));
    const result = await settle([REF]);

    expect(result.ok).toBe(true);
    expect(await refExists(REF)).toBe(false);
    expect(await refExists(RESCUE)).toBe(false);
  });

  it('rescues a legacy-shaped ref and the current one alike, without a name clash', async () => {
    const legacySha = await refWithUniqueCommit(LEGACY, 'legacy.txt');
    const currentSha = await refWithUniqueCommit(REF, 'current.txt');

    const result = await settle([REF, LEGACY]);

    expect(result.ok).toBe(true);
    expect((await project.git('rev-parse', RESCUE)).trim()).toBe(currentSha);
    expect((await project.git('rev-parse', `${RESCUE}-2`)).trim()).toBe(legacySha);
    expect(await refExists(REF)).toBe(false);
    expect(await refExists(LEGACY)).toBe(false);
  });

  it('leaves a ref a worktree still has checked out untouched', async () => {
    const sha = await refWithUniqueCommit(REF);
    await project.git('worktree', 'add', '-q', join(project.path, '..', `wt-${String(task.id)}`), REF);

    const result = await settle([REF], new Set([`refs/heads/${REF}`]));

    expect(result.ok).toBe(true);
    expect((await project.git('rev-parse', REF)).trim()).toBe(sha);
    expect(await refExists(RESCUE)).toBe(false);
    await project.git('worktree', 'remove', '--force', join(project.path, '..', `wt-${String(task.id)}`));
  });

  it('fails without touching the ref when it cannot be moved aside', async () => {
    const sha = await refWithUniqueCommit(REF);
    // A branch named like the rescue directory makes every `ralphctl-rescue/<sprint>/…` name unlockable.
    await project.git('branch', `ralphctl-rescue/${String(sprintId)}`);

    const result = await settle([REF]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        `could not move aside ${REF} holding 1 unlanded commit(s) — rename or delete it by hand, then relaunch`
      );
    }
    expect((await project.git('rev-parse', REF)).trim()).toBe(sha);
    expect(events).toEqual([]);
    expect(appended).toEqual([]);
  });
});
