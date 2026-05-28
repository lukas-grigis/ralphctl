import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { FIXED_NOW, absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
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
            dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
            timestamp: FIXED_NOW,
          },
        ],
      },
    }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    // The contract-driven evaluator renders `evaluation.md` via the WriteFile port. These
    // legacy tests cover prompt persistence (pre-spawn); a no-op writer is sufficient here.
    writeFile: async () => Result.ok(undefined),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
    progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
    model: 'test-model',
    plateauThreshold: 2,
    clock: () => FIXED_NOW,
    logger: noopLogger,
    eventBus: createInMemoryEventBus(),
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
});
