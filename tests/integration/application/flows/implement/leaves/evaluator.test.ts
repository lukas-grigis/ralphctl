import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { FIXED_NOW, absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
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

  const buildDeps = () => ({
    provider: createFakeAiProvider({
      // The fake provider parses the body for signals; an empty body returns zero signals,
      // which `runEvaluatorTurnUseCase` treats as a malformed exit. That terminates the loop
      // cleanly without affecting our concern (the rendered prompt has already been written).
      responses: { evaluate: '' },
    }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    model: 'test-model',
    plateauThreshold: 2,
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
    expect(content).toContain('# Code Review:');
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
});
