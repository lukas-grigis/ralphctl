import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import {
  buildPreflightLeaves,
  interruptedAttemptsByCwd,
} from '@src/application/flows/implement/leaves/sprint-repo-plan.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { stampPriorWorkOutcome } from '@src/domain/entity/task-prior-work.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import {
  absolutePath,
  isoTimestamp,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

const CWD = absolutePath('/tmp/repo');

const dirtyRunner: GitRunner = {
  run: (_cwd, args) =>
    Promise.resolve(Result.ok({ stdout: args[0] === 'status' ? ' M a.ts\n?? b.ts\n' : '', stderr: '', exitCode: 0 })),
};

const asked: Array<{ prompt: string; options: ReadonlyArray<Choice<unknown>> }> = [];
const interactive = {
  askChoice: (prompt: string, options: ReadonlyArray<Choice<unknown>>) => {
    asked.push({ prompt, options });
    return Promise.resolve(Result.ok('keep') as unknown as Result<never, StorageError>);
  },
} as unknown as InteractivePrompt;

const ctx = (): ImplementCtx => {
  const sid = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!sid.ok) throw new Error('fixture');
  return { sprintId: sid.value };
};

const runPreflight = async (hints: ReturnType<typeof interruptedAttemptsByCwd>): Promise<void> => {
  asked.length = 0;
  const [leaf] = buildPreflightLeaves(
    { gitRunner: dirtyRunner, interactive, clock: () => isoTimestamp('2026-10-01T10:00:00.000Z'), logger: noopLogger },
    [CWD],
    'prompt',
    hints
  );
  await leaf?.execute(ctx());
};

describe('dirty-tree preflight for an interrupted attempt', () => {
  it('names the interrupted attempt, and Keep stays the first (default) choice', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const repos = new Map<RepositoryId, RepoExecConfig>([[task.repositoryId, { path: CWD, name: 'repo' }]]);
    await runPreflight(interruptedAttemptsByCwd(repos, [task]));

    const [question] = asked;
    expect(question?.prompt).toContain('2 uncommitted change(s), likely from interrupted attempt 1');
    expect(question?.prompt).toContain(`"${task.name}"`);
    expect(question?.options[0]?.value).toBe('keep');
    expect(question?.options[0]?.description).toContain('resumed attempt continues');
  });

  it('warns that Reset also destroys the only copy when the interrupted attempt had restored its rejected diff', async () => {
    const running = makeInProgressTaskWithRunningAttempt();
    const stamped = stampPriorWorkOutcome(running, { kind: 'restored', stashMessage: 'ralphctl/s/t/blocked-diff' });
    if (!stamped.ok) throw stamped.error;
    const repos = new Map<RepositoryId, RepoExecConfig>([[running.repositoryId, { path: CWD, name: 'repo' }]]);
    const hints = interruptedAttemptsByCwd(repos, [stamped.value]);
    expect(hints.get(String(CWD))?.restoredPriorWork).toBe(true);

    await runPreflight(hints);

    const [question] = asked;
    expect(question?.prompt).toBe(
      `Working tree at ${String(CWD)} has 2 uncommitted change(s), likely from interrupted attempt 1 of "${running.name}" — which had restored its earlier rejected diff from git stash, so this tree now holds the only copy. Keep them to resume, or start clean?`
    );
    const reset = question?.options.find((o) => o.value === 'reset');
    expect(reset?.label).toBe('Reset — discard all uncommitted + untracked changes, then proceed');
    expect(reset?.description).toBe('also destroys that only copy of the restored rejected diff');
    expect(question?.options[0]?.description).toBe('the resumed attempt continues from them');
  });

  it('keeps the plain Reset description when the interrupted attempt restored nothing', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const repos = new Map<RepositoryId, RepoExecConfig>([[task.repositoryId, { path: CWD, name: 'repo' }]]);
    const hints = interruptedAttemptsByCwd(repos, [task]);
    expect(hints.get(String(CWD))?.restoredPriorWork).toBe(false);

    await runPreflight(hints);

    expect(asked[0]?.prompt).not.toContain('only copy');
    expect(asked[0]?.options.find((o) => o.value === 'reset')?.description).toBe('git reset --hard && git clean -fd');
  });

  it('keeps the plain copy when no attempt was interrupted', async () => {
    const task = makeTodoTask();
    const repos = new Map<RepositoryId, RepoExecConfig>([[task.repositoryId, { path: CWD, name: 'repo' }]]);
    expect(interruptedAttemptsByCwd(repos, [task]).size).toBe(0);
    await runPreflight(interruptedAttemptsByCwd(repos, [task]));
    expect(asked[0]?.prompt).not.toContain('interrupted');
    expect(asked[0]?.options[0]?.description).toContain('overwrite');
  });
});
