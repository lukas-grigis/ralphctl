import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { writeJsonAtomic, writeTextAtomic } from '@src/integration/io/fs.ts';
import type { EvalFlow } from './fixture-schema.ts';
import { createFakeProvider } from './fake-provider.ts';
import type { FlowAdapter, GradeToolbox, TrialContext, TrialPlan } from './flows/adapter.ts';
import { absPath } from './flows/narrow.ts';
import type { ArmConfig, Fixture, Grade, ResolvedRow, TrialRecord, TrialUsage } from './types.ts';
import { materialize } from './workspace.ts';

export interface TrialDeps {
  readonly adapters: Readonly<Record<EvalFlow, FlowAdapter>>;
  /** Live provider for a row. Ignored in dry-run, where a scripted fake replaces it. */
  readonly providerFor: (row: ResolvedRow) => HeadlessAiProvider;
  readonly dryRun: boolean;
  readonly toolbox: GradeToolbox;
  readonly logger: Logger;
  /** `settings.harness.correctiveRetries` — bounded corrective nudges, as in production. */
  readonly correctiveRetries: number;
  readonly keepWorkspaces: boolean;
  /** `evals/results/<runId>` — artifacts land under `trials/…` inside it. */
  readonly runDir: string;
  readonly now?: () => number;
}

export interface TrialRequest {
  readonly fixture: Fixture;
  readonly plan: TrialPlan;
  readonly arm: ArmConfig;
  readonly trialIndex: number;
  readonly loader: TemplateLoader;
  readonly signal?: AbortSignal;
}

/** Sums token counts across every spawn of a trial (primary + corrective nudges). */
interface UsageMeter {
  spawn(session: AiSession): Promise<Result<ProviderOutput, DomainError>>;
  total(): TrialUsage;
  lastSessionId(): string | undefined;
}

const createUsageMeter = (provider: HeadlessAiProvider, now: () => number): UsageMeter => {
  let inTokens = 0;
  let outTokens = 0;
  let sawIn = false;
  let sawOut = false;
  let metered = true;
  let wallMs = 0;
  let sessionId: string | undefined;
  return {
    async spawn(session) {
      const started = now();
      const result = await provider.generate(session);
      wallMs += now() - started;
      if (result.ok) {
        const usage = result.value.usage;
        if (usage?.inputTokens !== undefined) {
          inTokens += usage.inputTokens;
          sawIn = true;
        }
        if (usage?.outputTokens !== undefined) {
          outTokens += usage.outputTokens;
          sawOut = true;
        }
        // A SUCCESSFUL spawn without both counts is unmetered; a failed spawn reported nothing at all
        // and is not counted as unmetered. Absent counts are never imputed.
        if (usage?.inputTokens === undefined || usage.outputTokens === undefined) metered = false;
        sessionId = result.value.sessionId ?? sessionId;
      }
      return result;
    },
    total: () => ({
      inputTokens: sawIn ? inTokens : null,
      outputTokens: sawOut ? outTokens : null,
      durationMs: wallMs,
      metered,
    }),
    lastSessionId: () => sessionId,
  };
};

const isContractFailure = (error: DomainError): boolean =>
  error instanceof ParseError || error instanceof InvalidStateError;

const relDir = (req: TrialRequest): string =>
  join('trials', req.fixture.id, req.plan.variant, req.arm.name, String(req.trialIndex));

const baseRecord = (req: TrialRequest, artifactDir: string) => ({
  fixtureId: req.fixture.id,
  flow: req.fixture.flow,
  variant: req.plan.variant,
  trialIndex: req.trialIndex,
  arm: req.arm.name,
  tier: req.fixture.tier,
  cluster: req.fixture.cluster,
  origin: req.fixture.origin,
  ...(req.plan.defectClass !== undefined ? { defectClass: req.plan.defectClass } : {}),
  artifactDir,
});

const ZERO_USAGE: TrialUsage = { inputTokens: null, outputTokens: null, durationMs: 0, metered: true };

/**
 * Run ONE trial end to end: materialize an isolated workspace, build the prompt + session from the
 * shipped builders (via the flow adapter), spawn, validate `signals.json` with the same bounded
 * corrective nudges production uses, then grade. Infrastructure failures (workspace, spawn, grader
 * I/O) come back as a `graded: false` record so one flaky spawn never aborts a run; only
 * `AbortError` is returned as an error — it propagates untouched to the caller.
 */
export const runTrial = async (deps: TrialDeps, req: TrialRequest): Promise<Result<TrialRecord, AbortError>> => {
  const now = deps.now ?? Date.now;
  const artifactRel = relDir(req);
  const artifactAbs = join(deps.runDir, artifactRel);
  const adapter = deps.adapters[req.fixture.flow];
  const row = req.arm.rows[req.fixture.flow];
  const errored = (error: DomainError | string, usage: TrialUsage = ZERO_USAGE): TrialRecord => ({
    ...baseRecord(req, artifactRel),
    graded: false,
    correct: false,
    structurallyValid: false,
    nudgeCount: null,
    usage,
    error: typeof error === 'string' ? error : error.message,
  });

  const ws = await materialize(
    { git: deps.toolbox.git, ...(deps.toolbox.tmpRoot !== undefined ? { tmpRoot: deps.toolbox.tmpRoot } : {}) },
    req.fixture.dir,
    req.plan.patchRel
  );
  if (!ws.ok) return Result.ok(errored(ws.error));

  try {
    const artifactDir = absPath(artifactAbs);
    if (!artifactDir.ok) return Result.ok(errored(artifactDir.error));
    await fs.mkdir(artifactAbs, { recursive: true });
    const ctx: TrialContext = {
      fixture: req.fixture,
      plan: req.plan,
      workspace: ws.value,
      row,
      loader: req.loader,
      artifactDir: artifactDir.value,
      toolbox: deps.toolbox,
      ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
    };

    const prepared = await adapter.prepare(ctx);
    if (!prepared.ok) return Result.ok(errored(prepared.error));
    const trial = prepared.value;
    const wrotePrompt = await writeTextAtomic(join(String(trial.outputDir), 'prompt.md'), trial.session.prompt);
    if (!wrotePrompt.ok) return Result.ok(errored(wrotePrompt.error));

    let provider = deps.providerFor(row);
    if (deps.dryRun) {
      const canned = await adapter.dryRun(ctx);
      provider = createFakeProvider({
        responses: [canned.signals],
        ...(canned.sideEffect !== undefined ? { beforeWrite: async () => canned.sideEffect?.() } : {}),
      });
    }
    const meter = createUsageMeter(provider, now);

    const first = await meter.spawn(trial.session);
    if (!first.ok) {
      if (first.error instanceof AbortError) return Result.error(first.error);
      return Result.ok(errored(first.error, meter.total()));
    }

    // 0 retries degrades `validateSignalsFileWithCorrectiveRetry` to a single plain validation —
    // exactly what production does for flows that never nudge.
    const correctiveRetries = trial.nudges ? deps.correctiveRetries : 0;
    let outcomeSignals: readonly AiSignal[] = [];
    let valid = false;
    let nudgeCount: number | null = null;
    const validated = await trial.validate({
      outputDir: trial.outputDir,
      logger: deps.logger,
      correctiveRetries,
      selfContainedContext: trial.selfContainedContext,
      reinvoke: async (corrective: Prompt, attempt: number) => {
        const resume = meter.lastSessionId();
        const nudgeBody = absPath(join(String(trial.outputDir), `body-corrective-${String(attempt)}.txt`));
        const nudged: AiSession = {
          ...trial.session,
          prompt: corrective,
          ...(nudgeBody.ok ? { bodyFile: nudgeBody.value } : {}),
          ...(resume !== undefined ? { resume: resume as SessionId } : {}),
        };
        const respawn = await meter.spawn(nudged);
        return respawn.ok ? Result.ok(undefined) : Result.error(respawn.error);
      },
    });
    if (validated.ok) {
      valid = true;
      outcomeSignals = validated.value.signals;
      nudgeCount = validated.value.nudgeCount;
    } else if (validated.error instanceof AbortError) {
      return Result.error(validated.error);
    } else if (isContractFailure(validated.error)) {
      nudgeCount = correctiveRetries;
    } else {
      return Result.ok(errored(validated.error, meter.total()));
    }

    const graded: Result<Grade, DomainError> = await adapter.grade(ctx, { valid, signals: outcomeSignals });
    if (!graded.ok) {
      if (graded.error instanceof AbortError) return Result.error(graded.error);
      return Result.ok(errored(graded.error, meter.total()));
    }

    await fs.cp(String(trial.outputDir), artifactAbs, { recursive: true, force: true });
    await writeJsonAtomic(join(artifactAbs, 'grade.json'), graded.value);
    return Result.ok({
      ...baseRecord(req, artifactRel),
      graded: true,
      correct: graded.value.correct,
      structurallyValid: graded.value.structurallyValid,
      nudgeCount,
      usage: meter.total(),
      grade: graded.value,
    });
  } finally {
    if (!deps.keepWorkspaces) await ws.value.cleanup();
  }
};
