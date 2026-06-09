import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { createGenEvalLoop } from '@src/application/flows/implement/leaves/gen-eval-loop.ts';

/**
 * Loop-entry guard regression. When a terminal exit is ALREADY on ctx (the pre-task-verify
 * hard-block case — non-interactive red baseline / operator skip), the gen-eval loop's
 * `shouldContinue` must refuse to enter any turn: no round folder claimed, no meta sidecar
 * stamped, and crucially ZERO generator/evaluator spawns on the broken tree the gate refused
 * (the most expensive unit in the system).
 */
describe('createGenEvalLoop — loop-entry guard', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildLoop = () => {
    const generatorProvider = createFakeAiProvider({ responses: { implement: '' } });
    const evaluatorProvider = createFakeAiProvider({ responses: { evaluate: '' } });
    const task = makeInProgressTaskWithRunningAttempt();
    const loop = createGenEvalLoop(
      {
        generatorProvider,
        evaluatorProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: createInMemorySink<HarnessSignal>(),
        writeFile: async () => Result.ok(undefined),
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus: createInMemoryEventBus(),
        readConfig: async () => ({ maxTurns: 5 }),
        maxTurns: 5,
        plateauThreshold: 2,
      },
      {
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: root.root,
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        generator: { providerId: 'codex', model: 'test-gen-model' },
        evaluator: { providerId: 'codex', model: 'test-eval-model' },
      },
      task.id
    );
    return { loop, generatorProvider, evaluatorProvider, task };
  };

  it('refuses to enter any turn when ctx.lastExit is already set — zero generator/evaluator spawns', async () => {
    const { loop, generatorProvider, evaluatorProvider, task } = buildLoop();
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      // The pre-task-verify hard-block already stamped a self-blocked exit before the loop runs.
      lastExit: { kind: 'self-blocked', reason: 'baseline already red at task start (non-interactive)' },
      lastBlockReason: 'baseline already red at task start (non-interactive)',
    };

    const result = await loop.execute(ctx);

    expect(result.ok).toBe(true);
    // The body never executed — neither role's provider was spawned.
    expect(generatorProvider.recordedSessions).toHaveLength(0);
    expect(evaluatorProvider.recordedSessions).toHaveLength(0);
    if (result.ok) {
      // ctx threads through untouched — the exit the gate set still drives finalize/settle.
      expect(result.value.ctx.lastExit).toEqual(ctx.lastExit);
      // No turn ran, so the turn counter stays unset (the zero-turn discriminant downstream).
      expect(result.value.ctx.genEvalTurn).toBeUndefined();
    }
  });
});
