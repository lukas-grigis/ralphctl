/**
 * Real-git coverage for what a discarded reproduction leaves behind. The session's test must not stay
 * in the tree, where a killed one hangs the next verify run and any of them reads as unknown work;
 * it must stay recoverable; and nothing else in the tree may move.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createGitRunner, type GitRunner } from '@src/integration/io/git-runner.ts';
import { gitStashInspect, gitStashList, gitStashPop, stashEntryMatchesMessage } from '@src/integration/io/git-stash.ts';
import type { ShellScriptResult, ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { reproductionExcludeStashMessage } from '@src/application/flows/implement/leaves/pre-task-verify-internals/verify-execution.ts';
import { discardedReproductionStashMessage } from '@src/application/flows/implement/leaves/discarded-reproduction.ts';
import { reproduceLeaf } from '@src/application/flows/implement/leaves/reproduce.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;
const SPRINT_ID = 'sprint-x' as SprintId;
const TEST_PATH = 'tests/new/foo.test.ts';
const TRACKED_TEST = 'tests/existing.test.ts';

const reproduction = (testPath: string): HarnessSignal =>
  ({
    type: 'reproduction',
    testPath,
    runCommand: `npx vitest run ${testPath}`,
    observedFailure: 'expected 200, got 404',
    relevantTests: [],
    timestamp: TS,
  }) as unknown as HarnessSignal;

/** Emits one reproduction; the test file itself is written by the case, as the session would have. */
const fakeProvider = (testPath: string): HeadlessAiProvider & { readonly spawns: () => number } => {
  let spawns = 0;
  return {
    spawns: () => spawns,
    async generate(session): Promise<Result<ProviderOutput, DomainError>> {
      spawns += 1;
      const wrote = await writeJsonAtomic(String(session.signalsFile), {
        schemaVersion: 1,
        signals: [reproduction(testPath)],
      });
      if (!wrote.ok) return Result.error(wrote.error);
      return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
    },
  };
};

const reRun = (result: Result<ShellScriptResult, StorageError | AbortError>): ShellScriptRunner => ({
  run: () => Promise.resolve(result),
});
const killed = reRun(
  Result.ok({ passed: false, exitCode: null, output: '[timeout exceeded]', durationMs: 0, timedOut: true })
);
const passed = reRun(Result.ok({ passed: true, exitCode: 0, output: 'all green', durationMs: 0 }));
const spawnFailed = reRun(Result.error(new StorageError({ subCode: 'io', message: 'shell missing' })));
const failedOnItsOwn = reRun(Result.ok({ passed: false, exitCode: 1, output: 'boom', durationMs: 0 }));

const warningLogger = (): { readonly logger: Logger; readonly warns: string[] } => {
  const warns: string[] = [];
  const named: Logger = {
    ...noopLogger,
    warn: (message: string) => {
      warns.push(message);
    },
  };
  return { logger: { ...noopLogger, named: () => named }, warns };
};

describe('reproduceLeaf — a discarded reproduction (real git)', () => {
  let project: FakeProject;
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let cwd: AbsolutePath;
  let workspaceRoot: AbsolutePath;
  const task = makeTodoTask({ name: 'fix the null pointer' });
  const message = discardedReproductionStashMessage(SPRINT_ID, task.id);

  beforeEach(async () => {
    project = await createFakeProject({ seed: { [TRACKED_TEST]: 'committed\n', 'src/app.ts': 'export {};\n' } });
    cwd = absolutePath(project.path);
    root = await makeTmpRoot();
    workspaceRoot = absolutePath(join(String(root.root), 'implement', String(task.id)));
    await fs.mkdir(String(workspaceRoot), { recursive: true });
  });

  afterEach(async () => {
    await project.cleanup();
    await root.cleanup();
  });

  const run = (
    provider: HeadlessAiProvider,
    shellScriptRunner: ShellScriptRunner,
    io: { readonly gitRunner?: GitRunner; readonly logger?: Logger } = {}
  ): ReturnType<ReturnType<typeof reproduceLeaf>['execute']> =>
    reproduceLeaf(
      {
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: () => undefined,
        shellScriptRunner,
        gitRunner: io.gitRunner ?? createGitRunner(),
        writeFile: createAtomicWriteFile(),
        logger: io.logger ?? noopLogger,
      },
      { cwd, progressFile: absolutePath(join(String(root.root), 'progress.md')), model: 'claude-sonnet-4-6' },
      task.id
    ).execute({
      sprintId: SPRINT_ID,
      tasks: [task],
      taskWorkspaceRoot: workspaceRoot,
    } as unknown as ImplementCtx);

  const stashSubjects = async (): Promise<string[]> => {
    const listed = await gitStashList(createGitRunner(), cwd);
    if (!listed.ok) throw listed.error;
    return listed.value;
  };

  const currentBranch = async (): Promise<string> => (await project.git('branch', '--show-current')).trim();

  it.each([
    ['killed', killed],
    ['passing', passed],
    ['unspawnable', spawnFailed],
  ])('a %s re-run sets a new untracked test aside', async (_label, shell) => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');

    const result = await run(fakeProvider(TEST_PATH), shell);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
    await expect(project.readFile(TEST_PATH)).rejects.toThrow();
    expect(await project.git('status', '--porcelain')).toBe('');
    expect(await stashSubjects()).toEqual([`On ${await currentBranch()}: ${message}`]);
  });

  it('sets aside an edit to a tracked test file, back to the committed copy', async () => {
    await project.writeFile(TRACKED_TEST, 'committed\nplus the appended case\n');

    await run(fakeProvider(TRACKED_TEST), killed);

    expect(await project.readFile(TRACKED_TEST)).toBe('committed\n');
    expect(await project.git('status', '--porcelain')).toBe('');
  });

  it('keeps the test recoverable', async () => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');
    await project.writeFile(TRACKED_TEST, 'committed\nplus the appended case\n');

    await run(fakeProvider(TEST_PATH), killed);
    await run(fakeProvider(TRACKED_TEST), passed);

    await project.git('stash', 'pop');
    expect(await project.readFile(TRACKED_TEST)).toBe('committed\nplus the appended case\n');
    await project.git('stash', 'pop');
    expect(await project.readFile(TEST_PATH)).toBe('hangs forever\n');
  });

  it('moves only that path: earlier work in the tree stays exactly as it was', async () => {
    await project.writeFile('src/app.ts', 'export const restored = true;\n');
    await project.writeFile('src/staged.ts', 'export const staged = true;\n');
    await project.git('add', 'src/staged.ts');
    await project.writeFile('src/restored-new.ts', 'export const untracked = true;\n');
    await project.writeFile(TEST_PATH, 'hangs forever\n');
    const before = (await project.git('status', '--porcelain', '--untracked-files=all'))
      .split('\n')
      .filter((line) => line.length > 0 && !line.includes(TEST_PATH));

    await run(fakeProvider(TEST_PATH), killed);

    const after = (await project.git('status', '--porcelain', '--untracked-files=all'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(after).toEqual(before);
    expect(await project.readFile('src/app.ts')).toBe('export const restored = true;\n');
    expect(await project.readFile('src/restored-new.ts')).toBe('export const untracked = true;\n');
  });

  it('takes a path git would otherwise read as a glob literally', async () => {
    await project.writeFile('tests/[id]/route.test.ts', 'hangs forever\n');
    await project.writeFile('tests/i/route.test.ts', 'unrelated work\n');

    await run(fakeProvider('tests/[id]/route.test.ts'), killed);

    await expect(project.readFile('tests/[id]/route.test.ts')).rejects.toThrow();
    expect(await project.readFile('tests/i/route.test.ts')).toBe('unrelated work\n');
  });

  it('a normalised path inside the repo still works', async () => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');

    await run(fakeProvider(`./tests/../${TEST_PATH}`), killed);

    await expect(project.readFile(TEST_PATH)).rejects.toThrow();
  });

  it('a claimed test the session never wrote stashes nothing and warns about nothing', async () => {
    const { logger, warns } = warningLogger();

    const result = await run(fakeProvider(TEST_PATH), spawnFailed, { logger });

    expect(result.ok).toBe(true);
    expect(await stashSubjects()).toEqual([]);
    expect(warns.filter((w) => w.includes('set aside') || w.includes('stash'))).toEqual([]);
  });

  it.each([
    ['an absolute path', (): string => join(project.path, TEST_PATH)],
    ['a path outside the repo', (): string => '../outside.test.ts'],
    ['a path that starts inside and climbs out', (): string => 'tests/../../outside.test.ts'],
    ['the repo itself', (): string => '.'],
    ['a directory', (): string => 'tests/new'],
  ])('refuses %s: warns, stashes nothing, carries on', async (_label, unsafePath) => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');
    await project.writeFile('src/app.ts', 'export const restored = true;\n');
    const before = await project.git('status', '--porcelain', '--untracked-files=all');
    const { logger, warns } = warningLogger();

    const result = await run(fakeProvider(unsafePath()), killed, { logger });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
    expect(await stashSubjects()).toEqual([]);
    expect(await project.git('status', '--porcelain', '--untracked-files=all')).toBe(before);
    expect(warns.some((w) => w.includes('nothing set aside'))).toBe(true);
  });

  it('a failed stash warns and the flow carries on', async () => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');
    const real = createGitRunner();
    const gitRunner: GitRunner = {
      run: (dir, args, opts) =>
        args[0] === 'stash' && args[1] === 'push'
          ? Promise.resolve(Result.error(new StorageError({ subCode: 'io', message: 'git broke' })))
          : real.run(dir, args, opts),
    };
    const { logger, warns } = warningLogger();

    const result = await run(fakeProvider(TEST_PATH), killed, { gitRunner, logger });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
    expect(warns.some((w) => w.includes('could not set the discarded reproduction test aside'))).toBe(true);
  });

  it('an abort during the stash propagates rather than degrading', async () => {
    await project.writeFile(TEST_PATH, 'hangs forever\n');
    const real = createGitRunner();
    const gitRunner: GitRunner = {
      run: (dir, args, opts) => {
        if (args[0] === 'stash' && args[1] === 'push') throw new AbortError({ elementName: 'git', reason: 'aborted' });
        return real.run(dir, args, opts);
      },
    };

    const result = await run(fakeProvider(TEST_PATH), killed, { gitRunner });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });

  it('leaves an accepted reproduction in the tree', async () => {
    await project.writeFile(TEST_PATH, 'fails on its own\n');

    const result = await run(fakeProvider(TEST_PATH), failedOnItsOwn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact?.testPath).toBe(TEST_PATH);
    expect(await project.readFile(TEST_PATH)).toBe('fails on its own\n');
    expect(await stashSubjects()).toEqual([]);
  });

  describe('the stash entry it leaves', () => {
    it('names the sprint and the task, since worktrees share one stash list', () => {
      const other = makeTodoTask({ name: 'fix something else' });
      expect(message).toContain(String(SPRINT_ID));
      expect(message).toContain(String(task.id));
      expect(discardedReproductionStashMessage(SPRINT_ID, other.id)).not.toBe(message);
    });

    it('is never read as work to restore', async () => {
      await project.writeFile(TEST_PATH, 'hangs forever\n');
      await run(fakeProvider(TEST_PATH), killed);
      const runner = createGitRunner();
      const quarantine = quarantineStashMessage(SPRINT_ID, task.id);

      const [subject] = await stashSubjects();
      expect(subject).toBeDefined();
      expect(stashEntryMatchesMessage(subject ?? '', quarantine)).toBe(false);
      const inspected = await gitStashInspect(runner, cwd, quarantine);
      expect(inspected.ok && inspected.value).toEqual({ entries: 0 });
      const restored = await gitStashPop(runner, cwd, quarantine);
      expect(restored.ok && restored.value).toEqual({ popped: false });
      const baselineExclude = await gitStashPop(runner, cwd, reproductionExcludeStashMessage(SPRINT_ID, task.id));
      expect(baselineExclude.ok && baselineExclude.value).toEqual({ popped: false });
      expect(await stashSubjects()).toHaveLength(1);
    });

    it('does not make the next launch look like a relaunch with quarantined work', async () => {
      await project.writeFile(TEST_PATH, 'hangs forever\n');
      await run(fakeProvider(TEST_PATH), killed);

      await project.writeFile(TEST_PATH, 'fails on its own\n');
      const provider = fakeProvider(TEST_PATH);
      const result = await run(provider, failedOnItsOwn);

      expect(provider.spawns()).toBe(1);
      expect(result.ok && result.value.ctx.reproductionArtifact?.testPath).toBe(TEST_PATH);
    });
  });
});
