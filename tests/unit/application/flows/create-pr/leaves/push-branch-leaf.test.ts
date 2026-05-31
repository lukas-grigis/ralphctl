import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createPushBranchLeaf } from '@src/application/flows/create-pr/leaves/push-branch-leaf.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

const CWD = absolutePath('/tmp/repo');
const BRANCH = 'ralphctl/sprint-x';

const inMemoryExecutionRepo = (initial: SprintExecution): SprintExecutionRepository =>
  ({
    async findById(id: SprintId) {
      if (id !== initial.sprintId)
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      return Result.ok(initial);
    },
    async save() {
      return Result.ok(undefined);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as SprintExecutionRepository;

// Records every `git <argv>` invocation; routes a per-test answer per argv prefix.
const scriptedGitRunner = (
  answers: ReadonlyArray<{ args: readonly string[]; result: Result<GitRunResult, StorageError> }>
): { runner: GitRunner; calls: ReadonlyArray<readonly string[]> } => {
  const calls: Array<readonly string[]> = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push(args);
      const hit = answers.find((a) => a.args.every((tok, i) => args[i] === tok));
      if (!hit) {
        return Result.error(
          new StorageError({ subCode: 'io', message: `test: unexpected git invocation: git ${args.join(' ')}` })
        );
      }
      return hit.result;
    },
  };
  return { runner, calls };
};

// Stub repos / creator we don't exercise in push-branch — they belong to the create-pr leaf.
const stubSprintRepo = (): SprintRepository => ({}) as SprintRepository;
const stubTaskRepo = (): FindTasksBySprintId => ({
  async findBySprintId() {
    return Result.ok([]);
  },
});
const stubPullRequestCreator: PullRequestCreator = async () => Result.ok({ url: 'unused', platform: 'github' });

// AI-step stubs — push-branch never reaches them, but CreatePrDeps requires them present.
const stubProvider: HeadlessAiProvider = {
  async generate() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: provider should not be called' }));
  },
};
const stubTemplateLoader: TemplateLoader = {
  async load() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: loader should not be called' }));
  },
};
const stubWriteFile: CreatePrDeps['writeFile'] = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'test: writeFile should not be called' }));

const stubCreatePrDeps = (overrides: {
  runner: GitRunner;
  eventBus?: ReturnType<typeof createInMemoryEventBus>;
}): CreatePrDeps => ({
  sprintRepo: stubSprintRepo(),
  sprintExecutionRepo: inMemoryExecutionRepo(execution),
  taskRepo: stubTaskRepo(),
  pullRequestCreator: stubPullRequestCreator,
  gitRunner: overrides.runner,
  eventBus: overrides.eventBus ?? createInMemoryEventBus(),
  clock: () => FIXED_LATER,
  provider: stubProvider,
  templateLoader: stubTemplateLoader,
  writeFile: stubWriteFile,
  logger: noopLogger,
  model: 'test-model',
});

const sprint = makeReviewSprint();
const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), BRANCH);
const baseCtx = {
  input: {
    sprintId: sprint.id,
    cwd: CWD,
    sprintDir: absolutePath('/tmp/sprint-dir'),
    base: 'main',
    draft: false,
  },
};

describe('push-branch-leaf', () => {
  it('pushes the branch when the working tree matches the recorded sprint branch', async () => {
    const { runner, calls } = scriptedGitRunner([
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        result: Result.ok({ stdout: `${BRANCH}\n`, stderr: '', exitCode: 0 }),
      },
      { args: ['push', '-u', 'origin', BRANCH], result: Result.ok({ stdout: '', stderr: '', exitCode: 0 }) },
    ]);
    const eventBus = createInMemoryEventBus();
    const messages: string[] = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') messages.push(e.message);
    });

    const leaf = createPushBranchLeaf(stubCreatePrDeps({ runner, eventBus }));

    const out = await leaf.execute(baseCtx);

    expect(out.ok).toBe(true);
    // Push happened, with -u origin.
    const pushCall = calls.find((c) => c[0] === 'push');
    expect(pushCall).toEqual(['push', '-u', 'origin', BRANCH]);
    // Logs bracket the push.
    expect(messages.some((m) => m === `create-pr: pushing ${BRANCH} to origin`)).toBe(true);
    expect(messages.some((m) => m.includes(`${BRANCH} pushed`))).toBe(true);
  });

  it('refuses to push when the working tree is on a different branch', async () => {
    const { runner, calls } = scriptedGitRunner([
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        result: Result.ok({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      },
    ]);
    const leaf = createPushBranchLeaf(stubCreatePrDeps({ runner }));

    const out = await leaf.execute(baseCtx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error.code).toBe('invalid-state');
    expect(out.error.error.message).toContain("checked out 'main'");
    expect(out.error.error.message).toContain(`sprint branch is '${BRANCH}'`);
    // No push was attempted.
    expect(calls.find((c) => c[0] === 'push')).toBeUndefined();
  });

  it('surfaces a StorageError with stderr when `git push` exits non-zero (e.g. diverged remote)', async () => {
    const { runner } = scriptedGitRunner([
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        result: Result.ok({ stdout: `${BRANCH}\n`, stderr: '', exitCode: 0 }),
      },
      {
        args: ['push', '-u', 'origin', BRANCH],
        result: Result.ok({
          stdout: '',
          stderr: 'To origin\n ! [rejected]        ralphctl/sprint-x -> ralphctl/sprint-x (fetch first)\n',
          exitCode: 1,
        }),
      },
    ]);
    const leaf = createPushBranchLeaf(stubCreatePrDeps({ runner }));

    const out = await leaf.execute(baseCtx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toBeInstanceOf(StorageError);
    expect(out.error.error.message).toContain('git push failed');
    expect(out.error.error.message).toContain('(fetch first)');
  });

  it('propagates a spawn-level StorageError when the git runner itself fails', async () => {
    const runner: GitRunner = {
      async run() {
        return Result.error(new StorageError({ subCode: 'io', message: 'failed to spawn git: ENOENT' }));
      },
    };
    const leaf = createPushBranchLeaf(stubCreatePrDeps({ runner }));

    const out = await leaf.execute(baseCtx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toBeInstanceOf(StorageError);
    expect(out.error.error.message).toContain('failed to spawn git');
  });
});
