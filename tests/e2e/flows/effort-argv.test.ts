import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AskConfirmInput, Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { okGit } from '@tests/fixtures/git-result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeProviderSpawn, type ProviderSpawnCall } from '@tests/fixtures/provider-spawn-fake.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

/**
 * Argv-level proof that create-pr and review stamp an explicit effort on the provider CLI —
 * settings → `resolveEffort` → flow deps → leaf session → real headless adapter → spawn argv.
 * Both flows used to drop effort on the floor, so the CLI's own default applied (Claude Code runs
 * Opus 5.5 at `medium` when no `--effort` is passed). The spawn is a recording fake; nothing here
 * needs a real binary.
 */

/** Read the effort level each adapter spells into argv, or `undefined` when it is absent. */
const EFFORT_READERS: Readonly<
  Record<Exclude<AiProvider, 'opencode'>, (args: readonly string[]) => string | undefined>
> = {
  'claude-code': (args) => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined),
  'xai-grok': (args) => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined),
  'github-copilot': (args) => args.find((a) => a.startsWith('--effort='))?.slice('--effort='.length),
  'openai-codex': (args) =>
    args.find((a) => a.startsWith('model_reasoning_effort='))?.slice('model_reasoning_effort='.length),
};

const PROVIDERS = Object.keys(EFFORT_READERS) as ReadonlyArray<keyof typeof EFFORT_READERS>;

const settingsFor = (provider: AiProvider): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: defaultAiSettingsForProvider(provider),
  // One spawn per session — the recorded call is the one under test, no retry noise.
  harness: { ...DEFAULT_SETTINGS.harness, rateLimitRetries: 0 },
});

const firstSpawn = (calls: readonly ProviderSpawnCall[]): ProviderSpawnCall => {
  expect(calls.length).toBeGreaterThanOrEqual(1);
  return calls[0]!;
};

const sprintRepoFor = (sprint: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (id === sprint.id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save() {
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;

const taskRepo: TaskRepository = {
  async findBySprintId() {
    return Result.ok([]);
  },
  async findById() {
    return Result.error(new NotFoundError({ entity: 'task', id: 'missing' }));
  },
  async update() {
    return Result.ok(undefined);
  },
  async saveAll() {
    return Result.ok(undefined);
  },
};

const writeFile = async (path: Parameters<typeof writeTextAtomic>[0], content: string) =>
  writeTextAtomic(path, content);

let dir: string;
beforeEach(async () => {
  dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-effort-argv-')));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('create-pr — effort reaches the provider argv', () => {
  it.each(PROVIDERS)('%s: the createPr flow default lands on the CLI', async (providerId) => {
    const settings = settingsFor(providerId);
    const effort = resolveEffort('createPr', settings);
    expect(effort).toBe('low');
    const recording = makeProviderSpawn();
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/effort');
    const gitRunner: GitRunner = {
      async run(_cwd, args) {
        if (args[0] === 'rev-parse') return okGit('feature/effort\n');
        return okGit('');
      },
    };

    const flow = createCreatePrFlow(
      {
        sprintRepo: sprintRepoFor(sprint),
        sprintExecutionRepo: {
          async findById() {
            return Result.ok(exec);
          },
          async save() {
            return Result.ok(undefined);
          },
        } as unknown as SprintExecutionRepository,
        taskRepo,
        pullRequestCreator: async () => Result.ok({ url: 'https://github.com/o/r/pull/1', platform: 'github' }),
        gitRunner,
        eventBus: createInMemoryEventBus(),
        clock: () => FIXED_LATER,
        provider: createAiProvider({
          flow: 'createPr',
          ai: settings.ai,
          harnessConfig: settings.harness,
          eventBus: createInMemoryEventBus(),
          spawn: recording.spawn,
        }),
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile,
        logger: noopLogger,
        model: settings.ai.createPr.model,
        ...(effort !== undefined ? { effort } : {}),
        skillSource: emptySkillSource,
        skillsAdapter: noopSkillsAdapter,
      },
      { useAi: true, providerId }
    );
    const sprintDir = absolutePath(dir);
    // The spawn writes no signals.json, so the leaf falls back to the template — the PR still
    // opens. Only the argv the adapter handed the spawn matters here.
    const result = await flow.execute({
      input: { sprintId: sprint.id, cwd: sprintDir, sprintDir, base: 'main', draft: false },
    });

    expect(result.ok).toBe(true);
    expect(EFFORT_READERS[providerId](firstSpawn(recording.calls).args)).toBe('low');
  });
});

const unused = (method: string) => async (): Promise<never> => {
  throw new Error(`interactive.${method} not used here`);
};

/** One feedback round, then an empty submission ends the review loop. */
const oneRoundInteractive = (): InteractivePrompt => {
  let asked = 0;
  return {
    askText: unused('askText'),
    async askTextArea() {
      asked += 1;
      return Result.ok(asked === 1 ? 'tighten the error message' : '');
    },
    async askChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>): Promise<never> {
      void _prompt;
      void _options;
      throw new Error('interactive.askChoice not used here');
    },
    askMultiChoice: unused('askMultiChoice'),
    async askConfirm(_input: AskConfirmInput): Promise<never> {
      void _input;
      throw new Error('interactive.askConfirm not used here');
    },
  };
};

const noopShell: ShellScriptRunner = {
  async run() {
    return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
  },
};

describe('review — effort reaches the provider argv', () => {
  it.each(PROVIDERS)('%s: the implement generator effort lands on the CLI', async (providerId) => {
    const settings = settingsFor(providerId);
    // Review has no settings row of its own — the launcher resolves it through the implement row.
    const effort = resolveEffort('implement', settings);
    expect(effort).toBe('high');
    const recording = makeProviderSpawn();
    const sprint = makeReviewSprint();
    const cwd = absolutePath(join(dir, 'repo'));

    const flow = createReviewFlow(
      {
        sprintRepo: sprintRepoFor(sprint),
        taskRepo,
        provider: createAiProvider({
          row: settings.ai.implement.generator,
          harnessConfig: settings.harness,
          eventBus: createInMemoryEventBus(),
          spawn: recording.spawn,
        }),
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        interactive: oneRoundInteractive(),
        gitRunner: { run: async () => okGit('') },
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(dir),
        appendFile: createAppendFile(),
        model: settings.ai.implement.generator.model,
        ...(effort !== undefined ? { effort } : {}),
      },
      {
        sprintId: sprint.id,
        sprintDir: absolutePath(dir),
        reviewRoot: absolutePath(join(dir, 'review')),
        commitCwd: cwd,
        additionalRoots: [cwd],
        repositoriesBlock: `- \`${String(cwd)}\` (repo)`,
        feedbackFile: absolutePath(join(dir, 'feedback.md')),
      }
    );
    const runner = createRunner({
      id: `r-review-effort-${providerId}`,
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false } satisfies ReviewCtx,
    });
    // The spawn writes no signals.json, so the round fails validation after the spawn — the run
    // outcome is not under test, only the argv the adapter built for the round.
    await runner.start();

    expect(EFFORT_READERS[providerId](firstSpawn(recording.calls).args)).toBe('high');
  });
});
