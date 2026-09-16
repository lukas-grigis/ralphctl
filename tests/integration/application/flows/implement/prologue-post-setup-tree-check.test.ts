/**
 * Wiring fence for the post-setup working-tree check, driven through the REAL
 * `buildImplementPrologue` (the element both the serial flow and the parallel launcher run).
 *
 * The dirty-tree menu runs before the setup script, so dirt the script itself creates (a rewritten
 * lockfile, generated files that aren't ignored) would otherwise reach task 1 unannounced — swept
 * into its commit by `git add -A`, or misread as a broken baseline. These cases prove the prologue
 * re-asks exactly when setup changed the tree, and never otherwise.
 *
 * The git fake models the working tree as a set of porcelain lines: the shell fake adds the
 * setup script's output to it, and stash / reset clear it — so every status probe sees a
 * consistent tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  buildImplementPrologue,
  type CreateImplementFlowOpts,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';

import {
  absolutePath,
  FIXED_LATER,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
  slug,
} from '@tests/fixtures/domain.ts';
import { okGit } from '@tests/fixtures/git-result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

const REPO = absolutePath('/tmp/ralph/post-setup-repo');
const SETUP_COMMAND = 'make bootstrap';
const BRANCH = 'ralphctl/test';

interface WorkingTree {
  readonly runner: GitRunner;
  readonly lines: Set<string>;
  readonly calls: string[][];
}

const workingTree = (initial: readonly string[]): WorkingTree => {
  const lines = new Set(initial);
  const calls: string[][] = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      const [verb, sub] = args;
      if (verb === 'status' && sub === '--porcelain') {
        return okGit([...lines].map((l) => `${l}\n`).join(''), 0);
      }
      if (verb === 'rev-parse' && sub === '--abbrev-ref') return okGit(`${BRANCH}\n`, 0);
      if (verb === 'stash' && sub === 'push') {
        lines.clear();
        return okGit('Saved working directory\n', 0);
      }
      if (verb === 'reset' || verb === 'clean') {
        lines.clear();
        return okGit('', 0);
      }
      throw new Error(`unscripted git args: ${args.join(' ')}`);
    },
  };
  return { runner, lines, calls };
};

/** A setup script that writes `writes` into the tree when it runs (empty → well-behaved). */
const setupWriting = (tree: WorkingTree, writes: readonly string[]): ShellScriptRunner => ({
  async run() {
    for (const w of writes) tree.lines.add(w);
    return Result.ok({ passed: true, exitCode: 0, output: 'bootstrapped\n', durationMs: 5 });
  },
});

interface RecordingPrompt {
  readonly interactive: InteractivePrompt;
  readonly questions: string[];
}

const answering = (answers: readonly string[]): RecordingPrompt => {
  const questions: string[] = [];
  const unexpected = (): never => {
    throw new Error('prologue test: unexpected prompt kind');
  };
  const interactive: InteractivePrompt = {
    askText: unexpected,
    askTextArea: unexpected,
    askMultiChoice: unexpected,
    askConfirm: unexpected,
    async askChoice<T>(question: string, _options: ReadonlyArray<Choice<T>>) {
      void _options;
      const answer = answers[questions.length];
      questions.push(question);
      if (answer === undefined) throw new Error(`prologue test: unexpected question: ${question}`);
      return Result.ok(answer as T) as Result<T, StorageError>;
    },
  };
  return { interactive, questions };
};

interface Harness {
  readonly deps: ImplementDeps;
  readonly opts: CreateImplementFlowOpts;
  readonly initialCtx: ImplementCtx;
}

const buildHarness = (
  memoryRoot: AbsolutePath,
  tree: WorkingTree,
  setupWrites: readonly string[],
  prompt: RecordingPrompt
): Harness => {
  const ticket = makeApprovedTicket({ title: 'a-ticket' });
  let sprint: Sprint = makePlannedSprint({ tickets: [ticket] });
  let execution: SprintExecution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), BRANCH);
  const tasks: readonly Task[] = [
    makeTodoTask({ name: 'task-1', order: 1, ticketId: ticket.id, repositoryId: FIXED_REPOSITORY_ID }),
  ];
  const repositories = new Map<RepositoryId, RepoExecConfig>([
    [FIXED_REPOSITORY_ID, { path: REPO, name: 'repo', setupScript: SETUP_COMMAND }],
  ]);

  const deps = {
    sprintRepo: {
      findById: async () => Result.ok(sprint),
      list: async () => Result.ok([sprint]),
      save: async (next: Sprint) => {
        sprint = next;
        return Result.ok(undefined);
      },
    },
    sprintExecutionRepo: {
      findById: async () => Result.ok(execution),
      save: async (next: SprintExecution) => {
        execution = next;
        return Result.ok(undefined);
      },
    },
    taskRepo: { findBySprintId: async () => Result.ok(tasks) },
    eventBus: createInMemoryEventBus(),
    logger: noopLogger,
    clock: () => FIXED_LATER,
    gitRunner: tree.runner,
    shellScriptRunner: setupWriting(tree, setupWrites),
    interactive: prompt.interactive,
    appendFile: async () => Result.ok(undefined),
  } as unknown as ImplementDeps;

  const opts: CreateImplementFlowOpts = {
    sprintId: sprint.id,
    todoTasks: tasks,
    repositories,
    progressFile: absolutePath(`${String(memoryRoot)}/progress.md`),
    sprintDir: memoryRoot,
    generatorProviderId: 'claude-code',
    generatorModel: 'claude-opus-4-8',
    evaluatorProviderId: 'claude-code',
    evaluatorModel: 'claude-opus-4-8',
    memoryRoot,
    projectId: 'proj-post-setup',
    projectSlug: slug('proj-post-setup'),
  };
  return { deps, opts, initialCtx: { sprintId: sprint.id } };
};

describe('buildImplementPrologue — post-setup working-tree check', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('asks once, naming the setup script, when setup dirties a clean tree', async () => {
    const tree = workingTree([]);
    const prompt = answering(['stash']);
    const h = buildHarness(root, tree, ['?? src/generated.ts'], prompt);

    const out = await buildImplementPrologue(h.deps, h.opts).execute(h.initialCtx);

    expect(out.ok).toBe(true);
    expect(prompt.questions).toHaveLength(1);
    expect(prompt.questions[0]).toContain(SETUP_COMMAND);
    expect(tree.calls.some((a) => a[0] === 'stash' && a[1] === 'push')).toBe(true);
    // The green setup verdict described a tree the operator then stashed — it must not seed a
    // fresh-setup baseline for the first pre-task-verify.
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toBeUndefined();
  });

  it('asks nothing when setup leaves the tree unchanged', async () => {
    const tree = workingTree([]);
    const prompt = answering([]);
    const h = buildHarness(root, tree, [], prompt);

    const out = await buildImplementPrologue(h.deps, h.opts).execute(h.initialCtx);

    expect(out.ok).toBe(true);
    expect(prompt.questions).toHaveLength(0);
    if (out.ok) expect(out.value.ctx.setupVerifiedRepoIdsThisRun).toStrictEqual([FIXED_REPOSITORY_ID]);
  });

  it('never re-asks about dirt the operator chose to keep when setup changed nothing', async () => {
    const tree = workingTree([' M src/wip.ts']);
    const prompt = answering(['keep']);
    const h = buildHarness(root, tree, [], prompt);

    const out = await buildImplementPrologue(h.deps, h.opts).execute(h.initialCtx);

    expect(out.ok).toBe(true);
    // The one question is the up-front dirty-tree menu — not a second one after setup.
    expect(prompt.questions).toHaveLength(1);
    expect(prompt.questions[0]).not.toContain(SETUP_COMMAND);
  });

  it('asks again when setup adds dirt on top of kept changes, and a cancel aborts the run', async () => {
    const tree = workingTree([' M src/wip.ts']);
    const prompt = answering(['keep', 'cancel']);
    const h = buildHarness(root, tree, [' M package-lock.json'], prompt);

    const out = await buildImplementPrologue(h.deps, h.opts).execute(h.initialCtx);

    expect(prompt.questions).toHaveLength(2);
    expect(prompt.questions[1]).toContain(SETUP_COMMAND);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error.code).toBe(ErrorCode.Aborted);
  });
});
