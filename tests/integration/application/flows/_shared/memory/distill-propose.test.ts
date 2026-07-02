/**
 * Call-site test for the distill-propose leaf's abort-signal threading (Fix 1b).
 *
 * The distill sub-chain hands the terminal to an interactive AI via the same file-round-trip
 * seam as plan / refine / ideate. The leaf must forward its `execute()` signal as `abortSignal`
 * so a TUI cancel tears the stdio-inherit child down (attachAbortKill) rather than leaving it
 * running. This exercises the leaf directly against a port double that captures the input.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { absolutePath, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { DistillProposeLeafDeps } from '@src/application/flows/_shared/memory/distill-propose.ts';
import { distillProposeLeaf } from '@src/application/flows/_shared/memory/distill-propose.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

const record = (): LearningRecord => ({
  v: 1,
  id: 'id-1',
  text: 'always run lint before committing',
  repo: '/repos/app',
  repoName: 'app',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-05-29T10:00:00.000Z',
  promotedAt: null,
});

describe('distillProposeLeaf — abort signal threading', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let distillRoot: AbsolutePath;
  let repoPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    distillRoot = absolutePath(join(String(root.root), 'distill'));
    repoPath = join(String(root.root), 'repo');
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  /** Port double: records the run input and writes a proposal so the leaf reads a body back. */
  const fakeAi = (sink: { input?: InteractiveAiProviderInput }): InteractiveAiProvider => ({
    async run(input) {
      sink.input = input;
      await fs.writeFile(String(input.outputFile), '# Distilled\n\n## Learnings (ralphctl)\n\n- x\n', 'utf8');
      return Result.ok({});
    },
  });

  const buildDeps = (provider: InteractiveAiProvider): DistillProposeLeafDeps => ({
    interactiveAi: provider,
    runInTerminal: passthroughRunInTerminal,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    logger: noopLogger,
    model: 'claude-sonnet-4-6',
    distillRoot,
  });

  const buildCtx = (): DistillLearningsCtx => ({
    distillRequested: true,
    repository: makeRepository({ path: repoPath, name: 'repo' }),
    candidates: [record()],
    entries: {},
  });

  it('threads the leaf abort signal into the interactive provider', async () => {
    const controller = new AbortController();
    const sink: { input?: InteractiveAiProviderInput } = {};
    const leaf = distillProposeLeaf(buildDeps(fakeAi(sink)), 'claude-code');

    const result = await leaf.execute(buildCtx(), controller.signal);
    expect(result.ok).toBe(true);
    expect(sink.input?.abortSignal).toBe(controller.signal);
  });
});
