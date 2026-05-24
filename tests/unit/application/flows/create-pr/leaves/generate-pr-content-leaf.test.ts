import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppEvent, AiSignalEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { makeReviewSprint, absolutePath, FIXED_LATER } from '@tests/fixtures/domain.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  generatePrContentLeaf,
  type GeneratePrContentLeafDeps,
} from '@src/application/flows/create-pr/leaves/generate-pr-content-leaf.ts';
import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';

/**
 * Tests for the optional AI authoring leaf. The leaf's contract is "never block opening the
 * PR" — every recoverable failure (provider error, missing signals.json, schema mismatch,
 * sidecar write failure) returns `Result.ok` with `ctx.aiContent` left undefined so the
 * downstream create-pr leaf falls back to the template. AbortError is the one exception.
 */

const sharedTemplateLoader = createFsTemplateLoader(defaultTemplatesDir());

const realWriteFile: GeneratePrContentLeafDeps['writeFile'] = async (path, content) => {
  try {
    await fs.mkdir(dirname(String(path)), { recursive: true });
    await fs.writeFile(String(path), content, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'io', message: `test writeFile: ${String(cause)}` }));
  }
};

const buildCtx = (unitRoot: AbsolutePath, promptFile: AbsolutePath): CreatePrCtx => {
  const sprint = makeReviewSprint();
  return {
    input: {
      sprintId: sprint.id,
      cwd: absolutePath('/tmp/repo'),
      sprintDir: absolutePath('/tmp/sprint-dir'),
      base: 'main',
      draft: false,
    },
    sprint,
    tasks: [],
    headBranch: 'feature/test',
    currentUnitRoot: unitRoot,
    currentPromptFile: promptFile,
  };
};

const buildDeps = (provider: HeadlessAiProvider, eventBus = createInMemoryEventBus()): GeneratePrContentLeafDeps => ({
  provider,
  templateLoader: sharedTemplateLoader,
  writeFile: realWriteFile,
  eventBus,
  logger: noopLogger,
  model: 'test-model',
});

describe('generatePrContentLeaf', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;
  let unitRoot: AbsolutePath;
  let promptFile: AbsolutePath;
  let signalsFile: string;

  beforeEach(async () => {
    tmp = await makeTmpRoot();
    const unit = AbsolutePath.parse(join(String(tmp.root), 'unit'));
    if (!unit.ok) throw unit.error;
    await fs.mkdir(String(unit.value), { recursive: true });
    unitRoot = unit.value;
    const prompt = AbsolutePath.parse(join(String(unit.value), 'prompt.md'));
    if (!prompt.ok) throw prompt.error;
    promptFile = prompt.value;
    signalsFile = join(String(unitRoot), 'signals.json');
    // Silence unused FIXED_LATER lint by referencing it once.
    void FIXED_LATER;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('happy path: validates signals.json, projects pr-content onto ctx, writes sidecar, fans out event', async () => {
    const provider: HeadlessAiProvider = {
      async generate(session) {
        const payload = {
          schemaVersion: 1,
          signals: [
            {
              type: 'pr-content',
              title: 'AI title',
              body: 'AI body',
              timestamp: '2026-05-23T10:00:00.000Z',
            },
          ],
        };
        await fs.writeFile(String(session.signalsFile), JSON.stringify(payload), 'utf8');
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 } satisfies ProviderOutput) as Result<
          ProviderOutput,
          DomainError
        >;
      },
    };
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const leaf = generatePrContentLeaf(buildDeps(provider, eventBus));
    const result = await leaf.execute(buildCtx(unitRoot, promptFile));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.aiContent).toEqual({ title: 'AI title', body: 'AI body' });
    // Sidecar landed.
    const sidecar = await fs.readFile(join(String(unitRoot), 'pr-content.md'), 'utf8');
    expect(sidecar).toBe('# AI title\n\nAI body');
    // Fan-out event.
    const aiEvents = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiEvents.map((e) => e.signal.type)).toEqual(['pr-content']);
    expect(aiEvents[0]!.source).toBe('create-pr');
  });

  it('provider failure: returns ok with aiContent undefined (template fallback)', async () => {
    const provider: HeadlessAiProvider = {
      async generate() {
        return Result.error(new StorageError({ subCode: 'io', message: 'simulated provider failure' }));
      },
    };

    const leaf = generatePrContentLeaf(buildDeps(provider));
    const result = await leaf.execute(buildCtx(unitRoot, promptFile));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.aiContent).toBeUndefined();
  });

  it('signals.json missing after spawn: returns ok with aiContent undefined', async () => {
    const provider: HeadlessAiProvider = {
      async generate(session) {
        // Spawn succeeds but never writes signals.json — validateSignalsFile surfaces ENOENT.
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 } satisfies ProviderOutput) as Result<
          ProviderOutput,
          DomainError
        >;
      },
    };

    const leaf = generatePrContentLeaf(buildDeps(provider));
    const result = await leaf.execute(buildCtx(unitRoot, promptFile));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.aiContent).toBeUndefined();
    // No signals file was written.
    await expect(fs.access(signalsFile)).rejects.toThrow();
  });

  it('schema mismatch: returns ok with aiContent undefined', async () => {
    const provider: HeadlessAiProvider = {
      async generate(session) {
        // Wrong shape — `commit-message` is not part of the create-pr contract.
        const payload = {
          schemaVersion: 1,
          signals: [{ type: 'commit-message', subject: 'feat: x', timestamp: '2026-05-23T10:00:00.000Z' }],
        };
        await fs.writeFile(String(session.signalsFile), JSON.stringify(payload), 'utf8');
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 } satisfies ProviderOutput) as Result<
          ProviderOutput,
          DomainError
        >;
      },
    };

    const leaf = generatePrContentLeaf(buildDeps(provider));
    const result = await leaf.execute(buildCtx(unitRoot, promptFile));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.aiContent).toBeUndefined();
  });

  it('AbortError from provider propagates transparently (does not fall back)', async () => {
    const provider: HeadlessAiProvider = {
      async generate() {
        throw new AbortError({ elementName: 'generate-pr-content', reason: 'user cancelled' });
      },
    };

    const leaf = generatePrContentLeaf(buildDeps(provider));
    const result = await leaf.execute(buildCtx(unitRoot, promptFile));

    // The leaf framework treats throws as DomainError via Result.error — AbortError carries
    // the `code: 'aborted'` brand so it survives end-to-end.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
