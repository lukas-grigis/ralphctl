import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { recordRunningAttemptCritique } from '@src/domain/entity/task.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { FIXED_NOW, absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';

describe('generatorLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildDeps = () => ({
    provider: createFakeAiProvider({ responses: { implement: '' } }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    model: 'test-model',
    clock: () => FIXED_NOW,
    logger: noopLogger,
  });

  const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    progressFile: absolutePath(join(String(root.root), 'progress.md')),
    taskWorkspaceRoot: root.root,
  });

  it('persists generator prompt.md under rounds/<N>/generator/ on round 1', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '1', 'generator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain(task.name);
    // Marker line from the implement template — proves a fully-rendered prompt is on disk.
    expect(content).toContain('# Task Execution Protocol');
  });

  it('persists round 2 prompt with the prior critique injected', async () => {
    const base = makeInProgressTaskWithRunningAttempt();
    const critiqued = recordRunningAttemptCritique(
      base,
      'Tests fail on the empty-string boundary; cover it before re-submitting.'
    );
    expect(critiqued.ok).toBe(true);
    if (!critiqued.ok) return;
    const task = critiqued.value;

    // Pre-create rounds/1/ so `nextRoundNum` returns 2.
    await fs.mkdir(join(String(root.root), 'rounds', '1', 'generator'), { recursive: true });

    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '2', 'generator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain('## Prior Critique');
    expect(content).toContain('Tests fail on the empty-string boundary');
  });

  it('writes prompt.md atomically — no .tmp leftover on the target dir', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    await leaf.execute(baseCtx(task));

    const dir = join(String(root.root), 'rounds', '1', 'generator');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('prompt.md');
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });
});
