import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { makeProviderSpawn } from '@tests/fixtures/provider-spawn-fake.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

/**
 * A crash resume whose provider session vanished (the CLI no longer has the transcript — killed
 * mid-tool-call, pruned, another machine) must still run the task: the real Claude adapter sees
 * the stale-resume error and respawns cold with the FULL brief, not the slim "you were
 * interrupted" message that presumes a conversation the cold spawn does not have.
 */
describe('generator crash resume — vanished session', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  it('falls back to a cold spawn carrying the full implement prompt', async () => {
    const signalsFile = join(String(root.root), 'rounds', '1', 'generator', 'signals.json');
    const fake = makeProviderSpawn(({ index }) => {
      if (index === 0) return { stderrChunks: ['No conversation found with session ID: sess-gone\n'], exitCode: 1 };
      writeFileSync(signalsFile, JSON.stringify([{ type: 'task-verified', output: 'ok', timestamp: FIXED_NOW }]));
      return { exitCode: 0 };
    });
    const eventBus = createInMemoryEventBus();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(
      {
        provider: createClaudeProvider({ rateLimitRetries: 0, backoffSchedule: [0], eventBus, spawn: fake.spawn }),
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: createPublishSignal(eventBus, 'generator'),
        writeFile: async () => Result.ok(undefined),
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        providerId: 'claude-code',
        model: 'claude-opus-4-8',
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus,
        maxTurns: 5,
        plateauThreshold: 3,
        correctiveRetries: 2,
      },
      task.id
    );

    const result = await leaf.execute({
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      progressFile: absolutePath(join(String(root.root), 'progress.md')),
      taskWorkspaceRoot: root.root,
      currentRoundNum: 1,
      priorGeneratorSessionId: 'sess-gone' as ImplementCtx['priorGeneratorSessionId'],
      crashResumePending: true,
    });

    expect(result.ok).toBe(true);
    const [resumed, cold] = fake.calls;
    expect(resumed!.args).toContain('--resume');
    expect(resumed!.stdin).toContain('# Resume — Interrupted Attempt');
    expect(cold!.args).not.toContain('--resume');
    expect(cold!.stdin).toContain('# Task Execution Protocol');
    expect(cold!.stdin).not.toContain('# Resume — Interrupted Attempt');
    expect(fake.calls).toHaveLength(2);
  });
});
