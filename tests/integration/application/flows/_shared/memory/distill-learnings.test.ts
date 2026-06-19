/**
 * Integration tests for the self-contained distill sub-chain.
 *
 * Exercises {@link createDistillLearningsSubChain} end-to-end via the chain runner against a real
 * tmpdir, a fake `InteractiveAiProvider` that writes the proposed context file to `outputFile`,
 * an on-disk `WriteFile`, and a scripted `InteractivePrompt`. Asserts:
 *  - decline (`distillRequested === false`) → the `distill-gate` guard SKIPS the body: no AI
 *    session, no file write, ledger untouched.
 *  - accept → propose → confirm → write fires once PER DISTINCT PROVIDER.
 *  - a mixed-provider `ai` config → N native context files (one per distinct provider).
 *  - abort mid-distill → `AbortError` propagates and the ledger stays UN-stamped.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiProvider, AiSettings } from '@src/domain/entity/settings.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import {
  type LearningRecord,
  parseLearningLine,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  createDistillLearningsSubChain,
  type DistillLearningsDeps,
} from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath, isoTimestamp, makeRepository, projectId, slug } from '@tests/fixtures/domain.ts';
import { buildSluggedName } from '@src/integration/persistence/storage.ts';

const FIXED_NOW = isoTimestamp('2026-05-30T10:00:00.000Z');
const PROJECT_ID = projectId('01900000-0000-7000-8000-0000000000aa');
const PROJECT_SLUG = slug('demo-project');
/** The slugged per-project memory dir name distill now writes/reads via the direct-build path. */
const MEMORY_DIR = buildSluggedName(String(PROJECT_ID), String(PROJECT_SLUG));

const record = (over: Partial<LearningRecord> = {}): LearningRecord => ({
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
  ...over,
});

/**
 * Fake interactive AI: records every `run` input (so tests count per-provider spawns) and writes
 * a per-provider body to the requested `outputFile` — the distill propose leaf reads it back as
 * the proposal. When `abortOnCall` is set, the `runIndex`-th call returns `AbortError` WITHOUT
 * writing the output, modelling a Ctrl+C mid-distill.
 */
const fakeInteractiveAi = (opts: {
  readonly calls: InteractiveAiProviderInput[];
  readonly abortOnCall?: number;
}): InteractiveAiProvider => ({
  async run(input) {
    opts.calls.push(input);
    if (opts.abortOnCall !== undefined && opts.calls.length === opts.abortOnCall) {
      return Result.error(new AbortError({ elementName: 'distill-propose' }));
    }
    await fs.writeFile(
      String(input.outputFile),
      `# Distilled context for ${String(input.outputFile)}\n\n## Learnings (ralphctl)\n\n- always run lint before committing\n`,
      'utf8'
    );
    return Result.ok({});
  },
});

const scriptedConfirms = (answers: readonly boolean[]): { prompt: InteractivePrompt; confirmCount: () => number } => {
  let idx = 0;
  const prompt: InteractivePrompt = {
    async askText() {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askText not scripted' }));
    },
    async askTextArea() {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      return Result.error(
        new ValidationError({ field: 'fake', value: null, message: 'askChoice not scripted' })
      ) as Result<T, DomainError>;
    },
    async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
      return Result.ok([]);
    },
    async askConfirm() {
      const value = answers[idx];
      idx += 1;
      if (value === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted confirm' }));
      return Result.ok(value);
    },
  };
  return { prompt, confirmCount: () => idx };
};

const rowFor = (provider: AiProvider): { provider: AiProvider; model: string } => {
  if (provider === 'claude-code') return { provider, model: 'claude-sonnet-4-6' };
  if (provider === 'github-copilot') return { provider, model: 'claude-sonnet-4.5' };
  return { provider, model: 'gpt-5.3-codex' };
};

/** Build a flat AiSettings whose rows reference the requested providers. */
const buildAi = (per: {
  refine: AiProvider;
  plan: AiProvider;
  implement: AiProvider;
  readiness: AiProvider;
  ideate: AiProvider;
}): AiSettings => ({
  refine: rowFor(per.refine),
  plan: rowFor(per.plan),
  implement: { generator: rowFor(per.implement), evaluator: rowFor(per.implement) },
  readiness: rowFor(per.readiness),
  ideate: rowFor(per.ideate),
  createPr: rowFor(per.refine),
});

const allClaude = buildAi({
  refine: 'claude-code',
  plan: 'claude-code',
  implement: 'claude-code',
  readiness: 'claude-code',
  ideate: 'claude-code',
});

describe('createDistillLearningsSubChain', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let memoryRoot: AbsolutePath;
  let distillRoot: AbsolutePath;
  let repoPath: string;
  let ledgerPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    memoryRoot = absolutePath(join(String(root.root), 'memory'));
    distillRoot = absolutePath(join(String(root.root), 'distill'));
    repoPath = join(String(root.root), 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    ledgerPath = join(String(memoryRoot), MEMORY_DIR, 'learnings.ndjson');
    await fs.mkdir(join(String(memoryRoot), MEMORY_DIR), { recursive: true });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const seedLedger = async (lines: readonly string[]): Promise<void> => {
    await fs.writeFile(ledgerPath, lines.join(''), 'utf8');
  };

  const buildDeps = (over: Partial<DistillLearningsDeps> = {}): DistillLearningsDeps => ({
    interactiveAiFor: () => fakeInteractiveAi({ calls: [] }),
    runInTerminal: passthroughRunInTerminal,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    interactive: scriptedConfirms([true]).prompt,
    writeFile: createAtomicWriteFile(),
    logger: noopLogger,
    clock: () => FIXED_NOW,
    ...over,
  });

  const initialCtx = (distillRequested: boolean): DistillLearningsCtx => ({
    distillRequested,
    repository: makeRepository({ path: repoPath, name: 'repo' }),
    entries: {},
  });

  const run = async (chain: ReturnType<typeof createDistillLearningsSubChain>, ctx: DistillLearningsCtx) => {
    expect(chain.ok).toBe(true);
    if (!chain.ok) throw new Error('sub-chain build failed');
    const runner = createRunner({ id: 'r-distill', element: chain.value, initialCtx: ctx });
    await runner.start();
    return runner;
  };

  it('decline (distillRequested=false) → guard skips the body: no AI session, no write, ledger untouched', async () => {
    await seedLedger([serializeLearningRecord(record({ id: 'a' }))]);
    const originalLedger = await fs.readFile(ledgerPath, 'utf8');

    const calls: InteractiveAiProviderInput[] = [];
    const confirms = scriptedConfirms([]);
    const chain = createDistillLearningsSubChain(
      buildDeps({
        interactiveAiFor: () => fakeInteractiveAi({ calls }),
        interactive: confirms.prompt,
      }),
      { projectId: PROJECT_ID, projectSlug: PROJECT_SLUG, memoryRoot, distillRoot, ai: allClaude }
    );

    const runner = await run(chain, initialCtx(false));

    expect(runner.status).toBe('completed');
    // The guard skipped the body wholesale — no AI spawn, no confirm consumed.
    expect(calls).toHaveLength(0);
    expect(confirms.confirmCount()).toBe(0);
    // Ledger byte-for-byte untouched (no stamp).
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe(originalLedger);
    // No native context file landed in the repo.
    expect(await fileExists(join(repoPath, 'CLAUDE.md'))).toBe(false);
    // The guard emits exactly one `skipped` trace entry for the body.
    expect(runner.trace.map((t) => t.status)).toContain('skipped');
  });

  it('empty/absent ledger → distill-has-candidates guard skips the fold: no AI spawn, no warn, ledger untouched', async () => {
    // No ledger seeded at all (beforeEach only mkdir's the dir). load-learnings proposes an empty
    // candidate set, so the inner `distill-has-candidates` guard must skip the per-provider fold and
    // the stamp leaf — otherwise distill-propose would render an empty CANDIDATE_LEARNINGS and the
    // prompt's requireNonEmpty would fail, surfacing a spurious "distill failed" warn.
    const calls: InteractiveAiProviderInput[] = [];
    const confirms = scriptedConfirms([]);
    const warns: string[] = [];
    const warnLogger = {
      debug() {},
      info() {},
      warn(message: string) {
        warns.push(message);
      },
      error() {},
      named: () => warnLogger,
    } as unknown as DistillLearningsDeps['logger'];

    const chain = createDistillLearningsSubChain(
      buildDeps({
        interactiveAiFor: () => fakeInteractiveAi({ calls }),
        interactive: confirms.prompt,
        logger: warnLogger,
      }),
      { projectId: PROJECT_ID, projectSlug: PROJECT_SLUG, memoryRoot, distillRoot, ai: allClaude }
    );

    const runner = await run(chain, initialCtx(true));

    expect(runner.status).toBe('completed');
    // The fold was skipped wholesale — no AI spawn, no confirm consumed, no warn logged.
    expect(calls).toHaveLength(0);
    expect(confirms.confirmCount()).toBe(0);
    expect(warns).toHaveLength(0);
    // No native context file landed; the ledger file was never created.
    expect(await fileExists(join(repoPath, 'CLAUDE.md'))).toBe(false);
    expect(await fileExists(ledgerPath)).toBe(false);
    // The guard emits a `skipped` trace entry for the fold body (distill-fold).
    expect(runner.trace.some((t) => t.elementName === 'distill-fold' && t.status === 'skipped')).toBe(true);
  });

  it('accept (single provider) → propose→confirm→write fires once, ledger stamped', async () => {
    await seedLedger([serializeLearningRecord(record({ id: 'a' })), serializeLearningRecord(record({ id: 'b' }))]);

    const calls: InteractiveAiProviderInput[] = [];
    const chain = createDistillLearningsSubChain(
      buildDeps({
        interactiveAiFor: () => fakeInteractiveAi({ calls }),
        interactive: scriptedConfirms([true]).prompt,
      }),
      { projectId: PROJECT_ID, projectSlug: PROJECT_SLUG, memoryRoot, distillRoot, ai: allClaude }
    );

    const runner = await run(chain, initialCtx(true));

    expect(runner.status).toBe('completed');
    // Exactly one AI spawn for the single distinct provider (claude-code).
    expect(calls).toHaveLength(1);
    // The native context file landed.
    const claudeMd = join(repoPath, 'CLAUDE.md');
    expect(await fileExists(claudeMd)).toBe(true);
    expect(await fs.readFile(claudeMd, 'utf8')).toContain('## Learnings (ralphctl)');
    // Both candidates are now stamped promoted in the ledger.
    const promotedCount = await countPromoted(ledgerPath);
    expect(promotedCount).toBe(2);
  });

  it('mixed-provider config → one native context file per distinct provider', async () => {
    await seedLedger([serializeLearningRecord(record({ id: 'a' }))]);

    const callsByProvider = new Map<AiProvider, InteractiveAiProviderInput[]>();
    const interactiveAiFor = (provider: AiProvider): InteractiveAiProvider => {
      const calls = callsByProvider.get(provider) ?? [];
      callsByProvider.set(provider, calls);
      return fakeInteractiveAi({ calls });
    };

    // Three distinct providers across the rows → three distinct tools.
    const ai = buildAi({
      refine: 'github-copilot',
      plan: 'openai-codex',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'github-copilot',
    });

    const chain = createDistillLearningsSubChain(
      buildDeps({ interactiveAiFor, interactive: scriptedConfirms([true, true, true]).prompt }),
      { projectId: PROJECT_ID, projectSlug: PROJECT_SLUG, memoryRoot, distillRoot, ai }
    );

    const runner = await run(chain, initialCtx(true));

    expect(runner.status).toBe('completed');
    // One AI spawn per distinct provider.
    expect(callsByProvider.get('claude-code')).toHaveLength(1);
    expect(callsByProvider.get('github-copilot')).toHaveLength(1);
    expect(callsByProvider.get('openai-codex')).toHaveLength(1);
    // One native context file per distinct provider — no symlinks, three real files.
    expect(await fileExists(join(repoPath, 'CLAUDE.md'))).toBe(true);
    expect(await fileExists(join(repoPath, '.github', 'copilot-instructions.md'))).toBe(true);
    expect(await fileExists(join(repoPath, 'AGENTS.md'))).toBe(true);
  });

  it('abort mid-distill → AbortError propagates and the ledger stays UN-stamped', async () => {
    await seedLedger([serializeLearningRecord(record({ id: 'a' })), serializeLearningRecord(record({ id: 'b' }))]);
    const originalLedger = await fs.readFile(ledgerPath, 'utf8');

    // Two distinct providers; the SECOND provider's AI spawn aborts. The first provider's write
    // may land, but the stamp leaf must NOT run (sequential aborts the remainder), so the ledger
    // stays un-stamped and the learnings are re-runnable.
    const ai = buildAi({
      refine: 'claude-code',
      plan: 'github-copilot',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const allCalls: InteractiveAiProviderInput[] = [];
    // Abort on the 2nd AI spawn overall (the second distinct provider's propose).
    const interactiveAiFor = (): InteractiveAiProvider => fakeInteractiveAi({ calls: allCalls, abortOnCall: 2 });

    const chain = createDistillLearningsSubChain(
      buildDeps({ interactiveAiFor, interactive: scriptedConfirms([true, true]).prompt }),
      { projectId: PROJECT_ID, projectSlug: PROJECT_SLUG, memoryRoot, distillRoot, ai }
    );

    const runner = await run(chain, initialCtx(true));

    // The runner recognises a leaf-returned AbortError and surfaces `aborted` (not `failed`) —
    // `AbortError` is the one error chains forward transparently.
    expect(runner.status).toBe('aborted');
    // The cancellation point is recorded verbatim with code Aborted.
    const aborted = runner.trace.find((t) => t.error?.code === ErrorCode.Aborted);
    expect(aborted).toBeDefined();
    // The stamp leaf never ran — every record stays promotedAt:null, so the learnings are
    // re-runnable on the next attempt. Ledger byte-for-byte unchanged.
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe(originalLedger);
    expect(await countPromoted(ledgerPath)).toBe(0);
    // The stamp leaf is absent from the trace (sequential aborted before reaching it).
    expect(runner.trace.some((t) => t.elementName === 'stamp-promoted' && t.status === 'completed')).toBe(false);
  });
});

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
};

const countPromoted = async (path: string): Promise<number> => {
  const raw = await fs.readFile(path, 'utf8');
  let promoted = 0;
  for (const line of raw.split('\n')) {
    const parsed = parseLearningLine(line);
    if (!parsed.ok || parsed.value === undefined) continue;
    if (parsed.value.promotedAt !== null) promoted += 1;
  }
  return promoted;
};
