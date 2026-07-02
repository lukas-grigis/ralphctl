import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';

describe('evaluatorLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  /**
   * The audit-[09] evaluator contract REQUIRES exactly one `evaluation` signal per spawn. We
   * inject a minimal passing evaluation through `signals['evaluate']` so the post-spawn
   * `validateSignalsFile` step succeeds; these tests cover the leaf's pre-spawn prompt-write
   * side effect, not the contract-validation branches (those live in `evaluator-contract.test.ts`).
   */
  const buildDeps = () => ({
    provider: createFakeAiProvider({
      responses: { evaluate: '' },
      signals: {
        evaluate: [
          {
            type: 'evaluation',
            status: 'passed',
            // Full floor set so the signal passes the floor-dimension refinement cleanly — these
            // tests cover the leaf's pre-spawn prompt-write side effect, not the verdict, but a
            // vacuous PASS would now trip a corrective retry and muddy the assertions.
            dimensions: [
              { dimension: 'correctness', passed: true, finding: 'all good' },
              { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
              { dimension: 'safety', passed: true, finding: 'inputs validated' },
              { dimension: 'consistency', passed: true, finding: 'matches siblings' },
            ],
            timestamp: FIXED_NOW,
          },
        ],
      },
    }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    publishSignal: () => {},
    // The contract-driven evaluator renders `evaluation.md` via the WriteFile port. These
    // legacy tests cover prompt persistence (pre-spawn); a no-op writer is sufficient here.
    writeFile: async () => Result.ok(undefined),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
    progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
    model: 'test-model',
    plateauThreshold: 2,
    correctiveRetries: 2, // Stub git runner — these tests don't exercise the plateau fingerprint; a clean-tree
    // response keeps the post-spawn fingerprint call inert.
    gitRunner: {
      async run() {
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      },
    },
    clock: () => FIXED_NOW,
    logger: noopLogger,
  });

  it('persists evaluator prompt.md under rounds/<N>/evaluator/', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = evaluatorLeaf(buildDeps(), task.id);

    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      // Generator leaf is responsible for stamping `currentRoundNum`; for this test we set
      // it directly (the evaluator reads it as input).
      currentRoundNum: 3,
      taskWorkspaceRoot: root.root,
    };

    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '3', 'evaluator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain(task.name);
    expect(content).toContain('independent code reviewer');
  });

  it('writes prompt.md atomically — no .tmp leftover on the target dir', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = evaluatorLeaf(buildDeps(), task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);

    const dir = join(String(root.root), 'rounds', '1', 'evaluator');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('prompt.md');
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('uses the configured evaluator model regardless of task.escalatedToModel — escalation never touches the evaluator role', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    const stamped = recordTaskEscalation(initial, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const task = stamped.value;
    const deps = buildDeps();
    const leaf = evaluatorLeaf({ ...deps, model: 'evaluator-model-fixed' }, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    await leaf.execute(ctx);
    expect(deps.provider.recordedSessions[0]?.model).toBe('evaluator-model-fixed');
  });

  // Abort wire (keystone for #1/#5): the evaluator, like the generator, must carry the chain's
  // abort signal onto the spawned session so a TUI cancel mid-spawn kills the child via the
  // provider's SIGTERM ladder rather than letting it run to natural completion.
  it('threads the chain abort signal onto the spawned session so a cancel can kill the child', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const deps = buildDeps();
    const leaf = evaluatorLeaf(deps, task.id);
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: 1,
      taskWorkspaceRoot: root.root,
    };
    const controller = new AbortController();
    const result = await leaf.execute(ctx, controller.signal);
    expect(result.ok).toBe(true);
    expect(deps.provider.recordedSessions[0]?.abortSignal).toBe(controller.signal);
  });

  // Prompt selection by session continuity — mirrors the generator leaf. The FIRST evaluator
  // turn of a session thread re-sends the full specification + rubric; a RESUMED turn sends the
  // slim continuation prompt. A provider that never reports a session id always gets the full
  // prompt because the discriminant — `priorEvaluatorSessionId` — is the same field `--resume`
  // consumes.
  describe('prompt selection by session continuity', () => {
    const PASSING_EVAL: readonly HarnessSignal[] = [
      {
        type: 'evaluation',
        status: 'passed',
        dimensions: [
          { dimension: 'correctness', passed: true, finding: 'all good' },
          { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
          { dimension: 'safety', passed: true, finding: 'inputs validated' },
          { dimension: 'consistency', passed: true, finding: 'matches siblings' },
        ],
        timestamp: FIXED_NOW,
      },
    ];

    const readPrompt = (round: number): Promise<string> =>
      fs.readFile(join(String(root.root), 'rounds', String(round), 'evaluator', 'prompt.md'), 'utf8');

    const baseCtx = (
      task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>,
      roundNum: number
    ): ImplementCtx => ({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      currentRoundNum: roundNum,
      taskWorkspaceRoot: root.root,
    });

    it('sends the FULL evaluate prompt on the first turn (no prior session id)', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf(buildDeps(), task.id);
      const result = await leaf.execute(baseCtx(task, 1));
      expect(result.ok).toBe(true);

      const content = await readPrompt(1);
      expect(content).toContain('independent code reviewer');
      expect(content).not.toContain('# Re-evaluate — Round');
    });

    it('sends the CONTINUATION prompt on a resumed turn (prior session id present)', async () => {
      const provider = createFakeAiProvider({
        responses: { evaluate: '', 'evaluate-continuation': '' },
        signals: { evaluate: PASSING_EVAL, 'evaluate-continuation': PASSING_EVAL },
        sessionIds: { evaluate: 'eval-1' },
      });
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = evaluatorLeaf({ ...buildDeps(), provider }, task.id);

      const first = await leaf.execute(baseCtx(task, 1));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorEvaluatorSessionId).toBe('eval-1');
      expect(await readPrompt(1)).toContain('independent code reviewer');

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'evaluator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      const round2 = await readPrompt(2);
      expect(round2).toContain('# Re-evaluate — Round 2');
      expect(round2).not.toContain('## Review protocol'); // a heading unique to the full template
    });

    it('always sends the FULL prompt when the provider never reports a session id', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const deps = buildDeps(); // no sessionIds configured
      const leaf = evaluatorLeaf(deps, task.id);

      const first = await leaf.execute(baseCtx(task, 1));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorEvaluatorSessionId).toBeUndefined();

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'evaluator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      expect(await readPrompt(1)).toContain('independent code reviewer');
      expect(await readPrompt(2)).toContain('independent code reviewer');
      expect(await readPrompt(2)).not.toContain('# Re-evaluate — Round');
    });
  });
});
