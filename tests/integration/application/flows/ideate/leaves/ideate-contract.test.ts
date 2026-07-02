import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { IdeatedTicketsSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { DraftSprint } from '@src/domain/entity/sprint.ts';
import type { IdeateAndPlanLeafDeps } from '@src/application/flows/ideate/leaves/ideate-and-plan.ts';
import { ideateAndPlanLeaf } from '@src/application/flows/ideate/leaves/ideate-and-plan.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] ideate contract.
 *
 * Each case constructs a tmpdir, pre-writes a `signals.json` payload directly (skipping the
 * leaf's synth step) for the cases that need a specific shape, and asserts on the leaf's
 * `Result` + bus fan-out. Ideate has no sidecars; nothing else should land on disk beyond
 * `signals.json`.
 */

describe('ideateAndPlanLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let project: Project;
  let sprint: DraftSprint;
  let projectPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    project = makeProject();
    projectPath = String(project.repositories[0]?.path);
    sprint = makeDraftSprint();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const unitDir = (): string => join(String(root.root), 'ideate', 'session-1');
  const promptFilePath = (): string => join(unitDir(), 'prompt.md');
  // audit-[09] post-Wave-6: the AI writes `signals.json` directly under the unit root.
  const outputFilePath = (): string => join(unitDir(), 'signals.json');
  const signalsFilePath = (): string => join(unitDir(), 'signals.json');

  const ensureUnitDir = async (): Promise<void> => {
    await fs.mkdir(unitDir(), { recursive: true });
  };

  const fakeAi = (behaviour: (input: InteractiveAiProviderInput) => Promise<void>): InteractiveAiProvider => ({
    async run(input) {
      await behaviour(input);
      return Result.ok({});
    },
  });

  const buildDeps = (provider: InteractiveAiProvider, eventBus = createInMemoryEventBus()): IdeateAndPlanLeafDeps => {
    const writeFile: IdeateAndPlanLeafDeps['writeFile'] = async (path, content) => {
      try {
        await fs.mkdir(join(String(path), '..'), { recursive: true });
        await fs.writeFile(String(path), content, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error({ message: String(cause) } as never);
      }
    };
    return {
      interactiveAi: provider,
      runInTerminal: async (fn) => fn(),
      logger: noopLogger,
      writeFile,
      eventBus,
      model: 'claude-sonnet-4-6',
      maxAttempts: 3,
    };
  };

  const buildCtx = (): IdeateCtx => {
    const cwd = AbsolutePath.parse('/tmp/ralph/fake-repo');
    const unitRoot = AbsolutePath.parse(unitDir());
    const promptFile = AbsolutePath.parse(promptFilePath());
    const outputFile = AbsolutePath.parse(outputFilePath());
    if (!cwd.ok || !unitRoot.ok || !promptFile.ok || !outputFile.ok) throw new Error('path setup failed');
    return {
      sprintId: sprint.id,
      projectId: project.id,
      ideaTitle: 'Add CSV export',
      ideaText: 'Users want to export their data as CSV.',
      cwd: cwd.value,
      sprint,
      project,
      tasks: [],
      currentUnitRoot: unitRoot.value,
      currentPromptFile: promptFile.value,
      currentOutputFile: outputFile.value,
    };
  };

  const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    return { events, eventBus };
  };

  const ideatedTicketsSignal = (outputJson: string): IdeatedTicketsSignal => ({
    type: 'ideated-tickets',
    outputJson,
    timestamp: '2026-05-22T10:00:00.000Z' as IdeatedTicketsSignal['timestamp'],
  });

  const validOutputJson = (): string =>
    JSON.stringify({
      requirements: '## Requirements\n\n- export csv',
      tasks: [
        {
          name: 'Add CSV utility',
          projectPath,
          steps: ['create util', 'write tests'],
          verificationCriteria: [
            { id: 'C1', assertion: 'util exported', check: 'manual' },
            { id: 'C2', assertion: 'tests pass', check: 'manual' },
          ],
        },
      ],
    });

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates pre-written wrapper, projects ticket + tasks, fans out to bus', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [
          { type: 'learning', text: 'ideate notes', timestamp: '2026-05-22T10:00:00.000Z' },
          ideatedTicketsSignal(validOutputJson()),
        ],
      }),
      'utf8'
    );
    const { events, eventBus } = captureBus();
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider, eventBus));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['learning', 'ideated-tickets']);
    for (const ev of aiSignals) expect(ev.source).toBe('ideate');

    if (!result.ok) return;
    expect(result.value.ctx.addedTicket?.status).toBe('approved');
    expect(result.value.ctx.tasks).toHaveLength(1);
  });

  // ── 1b. Abort signal threading ────────────────────────────────────────────────
  it('threads the leaf abort signal into the interactive provider', async () => {
    // Fix 1b: the leaf must forward its execute() signal as `abortSignal` so a TUI cancel can
    // tear the stdio-inherit child down (attachAbortKill). Without this the child runs on.
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({ schemaVersion: 1, signals: [ideatedTicketsSignal(validOutputJson())] }),
      'utf8'
    );
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const provider = fakeAi(async (input) => {
      seen = input.abortSignal;
    });
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx(), controller.signal);
    expect(result.ok).toBe(true);
    expect(seen).toBe(controller.signal);
  });

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('ok-missing: surfaces signals-missing as InvalidStateError', async () => {
    await ensureUnitDir();
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('signals-missing');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('malformed JSON: surfaces ParseError(invalid-json)', async () => {
    await ensureUnitDir();
    await fs.writeFile(signalsFilePath(), '{ malformed json', 'utf8');
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('malformed JSON');
  });

  // ── 4. Schema fails Zod (wrong shape) ─────────────────────────────────────────
  it('ok with generator-only commit-message signal: surfaces ParseError(schema-mismatch)', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        // `commit-message` is intentionally not part of the ideate contract.
        signals: [{ type: 'commit-message', subject: 'feat: x', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 5a. Schema fails refine — zero ideated-tickets ────────────────────────────
  it('ok with zero ideated-tickets signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'note', text: 'no plan here', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one ideated-tickets');
  });

  // ── 5b. Schema fails refine — two ideated-tickets ─────────────────────────────
  it('ok with two ideated-tickets signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [ideatedTicketsSignal(validOutputJson()), ideatedTicketsSignal(validOutputJson())],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one ideated-tickets');
  });

  // ── 7. Legacy top-level-array migration ───────────────────────────────────────
  it('migrations[0] wraps legacy top-level array shape into the v1 envelope at load time', async () => {
    await ensureUnitDir();
    // In-flight pre-Wave-6 artifact on disk: a bare top-level `[ideated-tickets]` array.
    await fs.writeFile(signalsFilePath(), JSON.stringify([ideatedTicketsSignal(validOutputJson())]), 'utf8');
    const provider = fakeAi(async () => {});
    const { events, eventBus } = captureBus();
    const leaf = ideateAndPlanLeaf(buildDeps(provider, eventBus));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['ideated-tickets']);

    if (!result.ok) return;
    expect(result.value.ctx.addedTicket?.status).toBe('approved');
    expect(result.value.ctx.tasks).toHaveLength(1);
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    await ensureUnitDir();
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'ideate',
      message: 'simulated spawn failure',
    });
    const provider: InteractiveAiProvider = {
      async run() {
        return Result.error(spawnError);
      },
    };
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);
    await expect(fs.access(signalsFilePath())).rejects.toThrow();
  });

  // ── 9. Abort during spawn ─────────────────────────────────────────────────────
  it('abort: AbortError propagates transparently through the leaf', async () => {
    await ensureUnitDir();
    const provider: InteractiveAiProvider = {
      async run() {
        throw new AbortError({ elementName: 'mock-interactive', reason: 'aborted by fixture' });
      },
    };
    const leaf = ideateAndPlanLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
