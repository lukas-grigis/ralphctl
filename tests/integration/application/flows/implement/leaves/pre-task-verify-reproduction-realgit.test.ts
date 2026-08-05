/**
 * Real-git regression test for confirmed[9] — the reproduce leaf leaves a deliberately FAILING
 * test uncommitted in the working tree before the attempt loop, so every defect task's
 * pre-task-verify baseline used to be red for the wrong reason: the harness's OWN fixture, not a
 * pre-existing defect. A red pre-verify collapses `attributeVerify` onto `'baseline-broken'` no
 * matter what the AI's fix did, which is the ONE attribution `post-task-verify` treats as "not the
 * AI's fault, don't block" — silently defeating never-commit-on-red for a whole class of tasks.
 *
 * `pre-task-verify.ts` now excludes `ctx.reproductionArtifact.testPath` from the baseline gate run
 * (stash exactly that path around the gate, then restore it — see `withReproductionTestExcluded`
 * in `pre-task-verify-internals/verify-execution.ts`). This test proves BOTH invariants the fix
 * must hold at once, against a REAL git repo (no faked stash semantics):
 *
 *   (a) the attribution baseline reflects the tree WITHOUT the reproduction test — a green repo
 *       with an uncommitted failing repro test still records `lastPreVerifyOutcome === 'success'`;
 *   (b) the reproduction test survives the stash/restore cycle byte-for-byte and is back in the
 *       tree (untracked, dirty) by the time the leaf returns — the "quarantine/restore cycles keep
 *       the reproduction test intact" property the review's refuted best-of-n finding relied on.
 *
 * It then chains a real `postTaskVerifyLeaf` call (repro test back in the tree, still failing —
 * standing in for a fix that did not actually work) and asserts the resulting attribution is
 * `'regressed'`, not `'baseline-broken'` — which is what re-opens never-commit-on-red: `shouldBlock`
 * becomes true and `lastBlockReason` is set, exactly the behaviour the old code defeated.
 *
 * This test FAILS on the pre-fix code: without the exclusion, pre-verify sees the repro file
 * present, the shell runner (below) reports it red, `lastPreVerifyOutcome` comes back `'failed'`
 * instead of `'success'`, and the chained post-verify then computes `'baseline-broken'` (not
 * `'regressed'`) with no block reason.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitStashList, gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import type { ShellScriptRunner, ShellScriptResult } from '@src/integration/io/shell-script-runner.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbortError } from '@src/domain/value/error/abort-error.ts';
import {
  preTaskVerifyLeaf,
  type PreTaskVerifyEnvironment,
} from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import { postTaskVerifyLeaf } from '@src/application/flows/implement/leaves/post-task-verify.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ReproductionArtifact } from '@src/application/flows/implement/leaves/reproduce.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';

const sprintId = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const TTY_ENV: PreTaskVerifyEnvironment = { isStdinTty: true, isCi: false, isNoTui: false };

const REPRO_TEST_PATH = 'tests/unit/repro.test.ts';
const REPRO_CONTENT =
  "describe('repro', () => { it('fails until the fix lands', () => { expect(200).toBe(404); }); });\n";

/**
 * Shell runner that reads the REAL tree at call time — passes iff the reproduction test is NOT
 * present at `cwd/REPRO_TEST_PATH`, fails otherwise. This is the truthful stand-in for "the repo
 * is healthy except for the harness's own reproduction fixture": pre-verify (which excludes the
 * fixture) should see it green; post-verify (which runs the complete tree, fixture included, and
 * no fix has actually run in this test) should see it red.
 */
const reproAwareShellRunner = (cwd: string): ShellScriptRunner => ({
  async run(): Promise<Result<ShellScriptResult, StorageError | AbortError>> {
    const present = await fs
      .access(join(cwd, REPRO_TEST_PATH))
      .then(() => true)
      .catch(() => false);
    return Result.ok({
      passed: !present,
      exitCode: present ? 1 : 0,
      output: present ? 'repro test still present and failing' : 'all green',
      durationMs: 0,
    });
  },
});

const neverPrompt: InteractivePrompt = {
  async askText() {
    throw new Error('askText should not be called');
  },
  async askTextArea() {
    throw new Error('askTextArea should not be called');
  },
  async askChoice() {
    throw new Error('askChoice should not be called');
  },
  async askMultiChoice() {
    throw new Error('askMultiChoice should not be called');
  },
  async askConfirm() {
    throw new Error('askConfirm should not be called');
  },
};

interface FakeRepo extends UpdateTask {
  readonly updates: readonly Task[];
}

const fakeTaskRepo = (): FakeRepo => {
  const updates: Task[] = [];
  return {
    updates,
    async update(_sprintId, task) {
      updates.push(task);
      return Result.ok(undefined);
    },
  };
};

interface FakeExecRepo extends Save<SprintExecution> {
  readonly saves: readonly SprintExecution[];
}

const fakeExecRepo = (): FakeExecRepo => {
  const saves: SprintExecution[] = [];
  return {
    saves,
    async save(entity: SprintExecution) {
      saves.push(entity);
      return Result.ok(undefined);
    },
  };
};

describe('confirmed[9] — pre/post-task-verify attribution with a reproduction artifact present (real git)', () => {
  let project: FakeProject;

  beforeEach(async () => {
    project = await createFakeProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('green repo + uncommitted failing repro test → pre-verify records success, the test survives the exclude cycle intact, and a still-failing post-verify attributes "regressed" (not baseline-broken)', async () => {
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();

    // ── Simulate what `reproduce.ts` leaves in the tree before the attempt loop: a deliberately
    // failing test, uncommitted, untracked.
    await project.writeFile(REPRO_TEST_PATH, REPRO_CONTENT);
    const dirtyBefore = await gitStatusPorcelain(gitRunner, cwd);
    expect(dirtyBefore.ok && dirtyBefore.value.length).toBeGreaterThan(0);

    const artifact: ReproductionArtifact = {
      testPath: REPRO_TEST_PATH,
      runCommand: 'npx vitest run tests/unit/repro.test.ts',
      observedFailure: 'expected 200 to equal 404',
      relevantTests: [],
      checksum: 'irrelevant-for-this-test',
    };

    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId });
    const taskRepo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const shellRunner = reproAwareShellRunner(project.path);

    const preLeaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shellRunner,
        taskRepo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
        environment: TTY_ENV,
      },
      { cwd, verifyScript: 'check-repro' },
      task.id
    );

    const preCtx: ImplementCtx = {
      sprintId,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      reproductionArtifact: artifact,
    };

    const pre = await preLeaf.execute(preCtx);
    if (!pre.ok) throw new Error(`expected ok: ${pre.error.error.message}`);

    // (a) The attribution baseline reflects the tree WITHOUT the reproduction test: a green repo
    // records a green pre-verify even though the harness's own fixture is sitting uncommitted.
    expect(pre.value.ctx.lastPreVerifyOutcome).toBe('success');
    expect(pre.value.ctx.lastBlockReason).toBeUndefined();

    // (b) Quarantine/restore keeps the reproduction test intact: it is back on disk, byte-for-byte,
    // by the time the leaf returns — and no stash entry is left dangling.
    const restoredContent = await project.readFile(REPRO_TEST_PATH);
    expect(restoredContent).toBe(REPRO_CONTENT);
    // Scoped status probe (matching what the exclusion mechanism itself uses) — an unscoped
    // `git status --porcelain` collapses a whole newly-untracked directory into `?? tests/`
    // rather than naming the file, so the file-path assertion must scope to the exact pathspec.
    const scopedStatus = await gitRunner.run(cwd, ['status', '--porcelain', '--', REPRO_TEST_PATH]);
    expect(scopedStatus.ok && scopedStatus.value.stdout.trim()).toBe(`?? ${REPRO_TEST_PATH}`);
    const stashesAfterPre = await gitStashList(gitRunner, cwd);
    expect(stashesAfterPre.ok && stashesAfterPre.value).toEqual([]);

    // ── Chain post-task-verify: the repro test is back in the tree and still failing (standing in
    // for a fix that did not actually work). Post-verify runs the COMPLETE tree — no exclusion.
    const postLeaf = postTaskVerifyLeaf(
      {
        shellScriptRunner: shellRunner,
        taskRepo,
        gitRunner,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
      },
      { cwd, verifyScript: 'check-repro', maxAttempts: 3 },
      task.id
    );

    const post = await postLeaf.execute(pre.value.ctx);
    if (!post.ok) throw new Error(`expected ok: ${post.error.error.message}`);

    // Green pre + red post → 'regressed', the ONE attribution that BLOCKS — never-commit-on-red is
    // intact. Pre-fix, this would have come back 'baseline-broken' with no block reason.
    expect(post.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
    expect(post.value.ctx.lastBlockReason).toBeDefined();
    expect(post.value.ctx.lastBlockReason).toMatch(/regressed baseline/);
  });
});
