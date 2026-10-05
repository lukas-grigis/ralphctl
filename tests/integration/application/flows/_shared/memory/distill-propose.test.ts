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
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { DEFAULT_LEARNINGS_SECTION_HEADING } from '@src/integration/ai/prompts/distill-learnings/definition.ts';
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
      await fs.writeFile(String(input.outputFile), '- x\n', 'utf8');
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

  it('renders the same "(none detected)" PROJECT_TOOLING fallback markdown as the implement/evaluate renderer', async () => {
    // Pins distill-propose's local renderProjectTooling to the same italic fallback markup as
    // renderProjectToolingSection (task.ts) — the two renderers must not drift apart.
    const sink: { input?: InteractiveAiProviderInput } = {};
    const leaf = distillProposeLeaf(buildDeps(fakeAi(sink)), 'claude-code');

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const promptPath = join(String(distillRoot), 'claude-code', 'prompt.md');
    const promptBody = await fs.readFile(promptPath, 'utf8');
    expect(promptBody).toContain('_(none detected)_');
    expect(promptBody).not.toMatch(/(?<!_)\(none detected\)(?!_)/);
  });

  it('threads the harness output path into the prompt and leaves the real context file untouched', async () => {
    const sink: { input?: InteractiveAiProviderInput } = {};
    const leaf = distillProposeLeaf(buildDeps(fakeAi(sink)), 'claude-code');

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const outPath = join(String(distillRoot), 'claude-code', 'context-file.out');
    expect(String(sink.input?.outputFile)).toBe(outPath);
    const promptBody = await fs.readFile(join(String(distillRoot), 'claude-code', 'prompt.md'), 'utf8');
    expect(promptBody).toContain(outPath);
    expect(promptBody).not.toContain('at its original path');
  });
  it('does not splice a stale output from an earlier distill when the AI exits cleanly without writing', async () => {
    // First distill in this sprint writes its delta; the second AI session exits 0 but writes nothing.
    const first = distillProposeLeaf(buildDeps(fakeAi({})), 'claude-code');
    expect((await first.execute(buildCtx())).ok).toBe(true);
    const outPath = join(String(distillRoot), 'claude-code', 'context-file.out');
    await fs.writeFile(outPath, '- stale from the previous distill\n', 'utf8');

    const silent: InteractiveAiProvider = { run: async () => Result.ok({}) };
    const result = await distillProposeLeaf(buildDeps(silent), 'claude-code').execute(buildCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.error.message).toContain('wrote no output file');
    }
  });

  it('renders Context / Applies-to sub-bullets for candidates that carry them', async () => {
    const leaf = distillProposeLeaf(buildDeps(fakeAi({})), 'claude-code');
    const ctx: DistillLearningsCtx = {
      ...buildCtx(),
      candidates: [
        { ...record(), context: 'probing the cache layer', appliesTo: 'packaging' },
        { ...record(), id: 'id-2' },
      ],
    };
    expect((await leaf.execute(ctx)).ok).toBe(true);
    const promptBody = await fs.readFile(join(String(distillRoot), 'claude-code', 'prompt.md'), 'utf8');
    expect(promptBody).toContain('  - Context: probing the cache layer');
    expect(promptBody).toContain('  - Applies to: packaging');
    expect(promptBody.match(/- Context: probing/g)).toHaveLength(1);
  });

  it('treats an empty AI output with no owned section as a no-op, not a ValidationError', async () => {
    const empty: InteractiveAiProvider = {
      async run(input) {
        await fs.writeFile(String(input.outputFile), '\n', 'utf8');
        return Result.ok({});
      },
    };
    await fs.writeFile(join(repoPath, 'CLAUDE.md'), '# A\n\nhand written\n', 'utf8');
    const result = await distillProposeLeaf(buildDeps(empty), 'claude-code').execute(buildCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.entries['claude-code']?.proposedContent).toBe('# A\n\nhand written\n');
  });

  describe('splicing into an existing context file', () => {
    const bodyFake = (body: string): InteractiveAiProvider => ({
      async run(input) {
        await fs.writeFile(String(input.outputFile), body, 'utf8');
        return Result.ok({});
      },
    });
    const heading = `## ${DEFAULT_LEARNINGS_SECTION_HEADING}`;

    it('replaces the owned section and preserves everything else byte-for-byte', async () => {
      const before = '# Acme\r\n\r\nhand   written  \r\n\r\n';
      const after = '\r\n## Gotchas\r\n- keep\r\n';
      await fs.writeFile(join(repoPath, 'CLAUDE.md'), `${before}${heading}\r\n- old\r\n${after}`, 'utf8');
      const leaf = distillProposeLeaf(buildDeps(bodyFake('- new\n')), 'claude-code');

      const ctx = buildCtx();
      const result = await leaf.execute(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const proposed = result.value.ctx.entries['claude-code']?.proposedContent ?? '';
      expect(proposed.startsWith(before)).toBe(true);
      expect(proposed.endsWith(after)).toBe(true);
      expect(proposed).toContain('- new');
      expect(proposed).not.toContain('- old');
    });

    it('returns a ValidationError and proposes nothing on a duplicate owned heading', async () => {
      await fs.writeFile(join(repoPath, 'CLAUDE.md'), `# A\n\n${heading}\n- one\n\n${heading}\n- two\n`, 'utf8');
      const leaf = distillProposeLeaf(buildDeps(bodyFake('- new\n')), 'claude-code');

      const result = await leaf.execute(buildCtx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error).toBeInstanceOf(ValidationError);
    });

    it('returns a StorageError when the existing target cannot be read (not ENOENT)', async () => {
      await fs.mkdir(join(repoPath, 'CLAUDE.md'));
      const leaf = distillProposeLeaf(buildDeps(bodyFake('- new\n')), 'claude-code');

      const result = await leaf.execute(buildCtx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error).toBeInstanceOf(StorageError);
    });
  });
});
