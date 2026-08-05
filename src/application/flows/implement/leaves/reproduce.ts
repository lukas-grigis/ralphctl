import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
import type { ReproductionSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { currentSessionId } from '@src/application/session/session.ts';
import { deriveTaskKind } from '@src/business/task/derive-task-kind.ts';
import { buildReproducePrompt } from '@src/integration/ai/prompts/reproduce/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { reproduceOutputContract } from '@src/application/flows/implement/leaves/reproduce.contract.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { readCappedProgress } from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import { VERIFY_TAIL_MAX_CHARS } from '@src/application/flows/implement/leaves/_shared/verify-run-summary.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Reproduction-first leaf. A guarded, once-per-task headless AI session that runs BEFORE the
 * gen-eval loop for defect-shaped tasks: the session writes and runs one new failing test that
 * demonstrates the reported defect, then reports the test path, run command, observed failure,
 * and the existing tests it judged relevant (TestPrune, FSE 2026 — a cheap issue-relevant subset
 * lifts resolution 8-12.9% relative as a plug-in addition).
 *
 * Research grounding (ORACLE-SWE, arXiv 2604.07789): the paper's oracle-injection ablation shows
 * a reproduction test is the dominant single planning signal in isolation (SWE-bench Live, Claude
 * 4.5: 40% → 83% resolution) — but that figure is oracle-injected, not something a harness can
 * produce or claim. The harness-implementable variant is the paper's agent-extracted validation: a
 * stronger-extraction / weaker-fix pairing beats the strong model alone (Live: 54% vs 46%). This
 * leaf implements that agent-extracted arm, with one further deviation from the paper's pairing —
 * the session below runs on the SAME model/effort as the generator role, not a stronger rung, so
 * the extraction/fix pairing economy behind the 54%/46% figure is not realized here (see
 * `.claude/docs/RESEARCH-REFERENCES.md` for the full citation and deviation note).
 *
 * The harness never takes the session's word for it: after the spawn reports, this leaf re-runs
 * the claimed `runCommand` itself (once, bounded output) and accepts the artifact ONLY when that
 * re-run actually fails — a reproduction that passes proves nothing. On acceptance the leaf
 * checksums the test file's content so the evaluator prompt can later state that an unexplained
 * edit to it during the gen-eval loop is tampering, on the same footing as any other verification
 * tampering it already audits for.
 *
 * Failure tolerance is the point, not an afterthought: a failed session, a missing/invalid
 * `reproduction` signal, or a claimed command that turns out to pass on re-run all degrade to
 * today's behaviour — no reproduction context, logged at warn, task proceeds unaffected. Only a
 * fatal chain error (abort / exhausted rate limit) propagates.
 */
export interface ReproduceLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly publishSignal: PublishSignal;
  readonly shellScriptRunner: ShellScriptRunner;
  readonly logger: Logger;
}

export interface ReproduceLeafOpts {
  /** The repository working directory — both the session's cwd and the re-run's cwd. */
  readonly cwd: AbsolutePath;
  /** `<sprintDir>/progress.md` — inlined (capped) into the `<prior_progress>` prompt section. */
  readonly progressFile: AbsolutePath;
  /** Model this one-shot session runs on — mirrors the generator role's configured model. */
  readonly model: string;
  /** Optional reasoning / effort level — mirrors the generator role's configured effort. */
  readonly effort?: string;
}

/**
 * Validated reproduction artifact the leaf stamps onto `ctx.reproductionArtifact`. Carries
 * forward into the generator (round 1 + continuation) and evaluator (round 1 + continuation)
 * prompts of the SAME task's gen-eval loop — see `generator.ts` / `evaluator.ts`.
 *
 * `observedFailure` is the HARNESS's own bounded re-run capture, not the session's self-report —
 * the field that was just verified is the one that rides forward. `checksum` is a content hash of
 * `testPath` at validation time, recorded so a later unexplained edit is detectable as tampering.
 *
 * @public
 */
export interface ReproductionArtifact {
  readonly testPath: string;
  readonly runCommand: string;
  readonly observedFailure: string;
  readonly relevantTests: readonly string[];
  readonly checksum: string;
}

interface ReproduceInput {
  readonly task: Task;
  readonly workspaceRoot: AbsolutePath;
}

interface ReproduceOutput {
  readonly artifact?: ReproductionArtifact;
}

/**
 * Render a validated {@link ReproductionArtifact} into the plain-text body the generator and
 * evaluator prompt builders accept as `reproduction` — they wrap it in the `<reproduction>` tag
 * with their own role-specific framing, so this stays unwrapped, structural content only. Shared
 * by `generator.ts` and `evaluator.ts` so both roles describe the same artifact identically.
 *
 * @public
 */
export const renderReproductionBody = (artifact: ReproductionArtifact): string =>
  [
    `Test: \`${artifact.testPath}\``,
    `Run command: \`${artifact.runCommand}\``,
    '',
    artifact.relevantTests.length > 0
      ? `Relevant existing tests: ${artifact.relevantTests.map((t) => `\`${t}\``).join(', ')}`
      : 'Relevant existing tests: none found.',
    '',
    'Observed failure (harness re-run):',
    '```',
    artifact.observedFailure,
    '```',
  ].join('\n');

/**
 * Read-side convenience for `generator.ts` / `evaluator.ts`'s `input` projections — both compose
 * their `reproduction` prompt field from the SAME `ctx.reproductionArtifact` this leaf validated,
 * so the one-line read lives here instead of being duplicated at each call site.
 *
 * @public
 */
export const readReproductionSection = (ctx: ImplementCtx): string | undefined =>
  ctx.reproductionArtifact !== undefined ? renderReproductionBody(ctx.reproductionArtifact) : undefined;

/**
 * Gate predicate for the guard wrapping this leaf — defect-shaped tasks only. Reads `ctx.tasks`
 * (the leaf runs BEFORE `start-attempt`, so `ctx.currentTask` is not set yet), mirroring
 * `dependency-gate.ts`'s `isTaskRunnable`. A task classified anything other than `'bugfix'` by
 * {@link deriveTaskKind} skips silently — the guard primitive records a `skipped` trace entry,
 * no AI spawn happens, `ctx.reproductionArtifact` stays undefined.
 *
 * @public
 */
export const isDefectShapedTask = (ctx: ImplementCtx, taskId: TaskId): boolean => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  return task !== undefined && deriveTaskKind(task) === 'bugfix';
};

const CHECKSUM_ALGORITHM = 'sha256';

const computeChecksum = (content: string): string =>
  createHash(CHECKSUM_ALGORITHM).update(content, 'utf-8').digest('hex');

/**
 * Keep the END of a captured run — the decisive failure line sits at the bottom of test-runner
 * output. Mirrors `_shared/verify-run-summary.ts`'s clamp so every prompt-embedded command
 * output in the implement chain shares one budget.
 */
const clampOutput = (raw: string): string => {
  const trimmed = raw.trim();
  return trimmed.length > VERIFY_TAIL_MAX_CHARS ? `…${trimmed.slice(trimmed.length - VERIFY_TAIL_MAX_CHARS)}` : trimmed;
};

/**
 * Per-call `AiSession` for the reproduce spawn. FULL_AUTO (not the read-only profile the other
 * one-shot flows use) because the session must write a new test file AND run it — the prompt's
 * `<constraints>` block is what actually keeps the session to reproduction-only work; the
 * harness-side backstop is {@link verifyReproductionFails} below, which discards any artifact
 * whose claimed command does not actually fail on the harness's own re-run.
 */
const buildReproduceSession = (opts: {
  readonly cwd: AbsolutePath;
  readonly prompt: Prompt;
  readonly model: string;
  readonly effort: string | undefined;
  readonly signalsFile: AbsolutePath;
  readonly outputDir: AbsolutePath;
  readonly bodyFile: AbsolutePath;
  readonly abortSignal: AbortSignal | undefined;
}): AiSession => {
  const chainSessionId = currentSessionId();
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.model,
    permissions: FULL_AUTO,
    signalsFile: opts.signalsFile,
    outputDir: opts.outputDir,
    bodyFile: opts.bodyFile,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  };
};

/** Structured outcome of the harness's own re-run — the ONLY authority on whether an artifact is accepted. */
type VerifyOutcome =
  | { readonly kind: 'accepted'; readonly observedFailure: string }
  | { readonly kind: 'discarded' }
  | { readonly kind: 'fatal'; readonly error: DomainError };

/**
 * Re-run the session's claimed `runCommand` once against the repo, bounded output. Only a
 * command that actually fails is accepted as a reproduction — a passing re-run means the
 * session's claim does not hold (or the code was fixed in the same session) and proves nothing,
 * so it is discarded rather than threaded forward. A run-time spawn failure degrades the same
 * way; only a fatal chain error (abort / exhausted rate limit) propagates.
 */
const verifyReproductionFails = async (
  deps: Pick<ReproduceLeafDeps, 'shellScriptRunner'>,
  cwd: AbsolutePath,
  runCommand: string,
  abortSignal: AbortSignal | undefined
): Promise<VerifyOutcome> => {
  const ran = await deps.shellScriptRunner.run(
    cwd,
    runCommand,
    abortSignal !== undefined ? { signal: abortSignal } : {}
  );
  if (!ran.ok) return isFatalChainError(ran.error) ? { kind: 'fatal', error: ran.error } : { kind: 'discarded' };
  if (ran.value.passed) return { kind: 'discarded' };
  return { kind: 'accepted', observedFailure: clampOutput(ran.value.output) };
};

/**
 * Read the reproduction test file the session claims to have written and checksum its content.
 * `undefined` on any read failure (missing file, unreadable path) — treated as a discard, never
 * a chain failure; file IO here carries no abort surface.
 */
const checksumTestFile = async (cwd: AbsolutePath, testPath: string): Promise<string | undefined> => {
  const parsed = AbsolutePath.parse(join(String(cwd), testPath));
  if (!parsed.ok) return undefined;
  try {
    const content = await fs.readFile(String(parsed.value), 'utf8');
    return computeChecksum(content);
  } catch {
    return undefined;
  }
};

/**
 * Bounded note {@link buildEvaluatorReproductionSection} appends to the rendered reproduction
 * body when the harness's own re-checksum no longer matches {@link ReproductionArtifact.checksum}
 * — i.e. the test file was edited (or deleted) since this leaf validated it. Folded into the SAME
 * `<reproduction>` section the tampering-detection rule in `evaluate/template.md` already audits,
 * rather than a separate signal — one tampering vocabulary, one place the evaluator looks.
 *
 * @public
 */
export const REPRODUCTION_TAMPER_NOTE =
  'TAMPERING CHECK: the reproduction test file no longer matches the content hashed when it was ' +
  'validated before this attempt began. Treat this the same as any other verification tampering — ' +
  'it needs an explicit, justified explanation this round, not a silent pass.';

/**
 * Re-checksum `artifact.testPath` against the hash captured at validation time. `true` on any
 * mismatch — INCLUDING a file that is now missing or unreadable, which is at least as suspicious
 * as an edit (`checksumTestFile` returns `undefined` in that case, which never equals a real
 * hash). Never throws.
 *
 * @public
 */
export const reproductionTestTampered = async (cwd: AbsolutePath, artifact: ReproductionArtifact): Promise<boolean> => {
  const current = await checksumTestFile(cwd, artifact.testPath);
  return current !== artifact.checksum;
};

/**
 * Evaluator-only render: {@link renderReproductionBody} plus a bounded tamper note when the
 * harness's own re-checksum of `testPath` no longer matches the hash captured at validation time.
 * `generator.ts` keeps using the plain (pure, sync) `readReproductionSection` — only the evaluator
 * re-checks, once per turn, since detecting an unexplained edit during the gen-eval loop is its
 * job, not the generator's.
 *
 * @public
 */
export const buildEvaluatorReproductionSection = async (
  cwd: AbsolutePath,
  artifact: ReproductionArtifact
): Promise<string> => {
  const body = renderReproductionBody(artifact);
  const tampered = await reproductionTestTampered(cwd, artifact);
  return tampered ? `${body}\n\n${REPRODUCTION_TAMPER_NOTE}` : body;
};

/**
 * Spawn the reproduce session, validate `signals.json` against {@link reproduceOutputContract},
 * and extract the single `reproduction` signal the contract guarantees. Any expected failure
 * (spawn / validation) degrades to `undefined`, logged at warn; a fatal chain error propagates as
 * `Result.error`.
 */
const runReproduceSession = async (
  deps: ReproduceLeafDeps,
  opts: ReproduceLeafOpts,
  taskId: TaskId,
  task: Task,
  reproduceDir: AbsolutePath,
  abortSignal: AbortSignal | undefined
): Promise<Result<ReproductionSignal | undefined, DomainError>> => {
  const log = deps.logger.named('implement.reproduce');

  const paths = runPathsFor(reproduceDir);
  if (!paths.ok) return Result.error(paths.error);

  const outputContractSection = renderContractSectionFor(reproduceOutputContract, reproduceDir);
  const priorProgress = await readCappedProgress(String(opts.progressFile), String(taskId), opts.model);

  const prompt = await buildReproducePrompt(deps.templateLoader, {
    task,
    projectPath: String(opts.cwd),
    priorProgress,
    outputContractSection,
  });
  if (!prompt.ok) return Result.error(prompt.error);

  const promptWrote = await writeTextAtomic(String(paths.value.promptFile), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  const session = buildReproduceSession({
    cwd: opts.cwd,
    prompt: prompt.value,
    model: opts.model,
    effort: opts.effort,
    signalsFile: paths.value.signalsFile,
    outputDir: reproduceDir,
    bodyFile: paths.value.bodyFile,
    abortSignal,
  });

  const spawn = await deps.provider.generate(session);
  if (!spawn.ok) {
    if (isFatalChainError(spawn.error)) return Result.error(spawn.error);
    log.warn(`reproduce session failed for task '${String(taskId)}' — continuing without a reproduction`, {
      taskId: String(taskId),
      error: spawn.error.message,
    });
    return Result.ok(undefined);
  }

  const validated = await validateSignalsFile(reproduceDir, reproduceOutputContract);
  if (!validated.ok) {
    // No fatal-error guard here by design: `validateSignalsFile` only reads + parses
    // signals.json (no spawn / cancellation surface), so its error union cannot carry an
    // abort or rate-limit code.
    log.warn(`reproduce signals invalid for task '${String(taskId)}' — continuing without a reproduction`, {
      taskId: String(taskId),
      error: validated.error.message,
    });
    return Result.ok(undefined);
  }

  for (const sig of validated.value) deps.publishSignal(sig);

  const reproduction = validated.value.find((s): s is ReproductionSignal => s.type === 'reproduction');
  if (reproduction === undefined) {
    // Defensive — the contract's exactly-one refine should have caught this upstream.
    log.warn(`reproduce signals for task '${String(taskId)}' validated without a reproduction signal`, {
      taskId: String(taskId),
    });
    return Result.ok(undefined);
  }
  return Result.ok(reproduction);
};

const reproduceUseCase = async (
  deps: ReproduceLeafDeps,
  opts: ReproduceLeafOpts,
  taskId: TaskId,
  input: ReproduceInput,
  abortSignal?: AbortSignal
): Promise<Result<ReproduceOutput, DomainError>> => {
  const log = deps.logger.named('implement.reproduce');
  const reproduceDir = AbsolutePath.parse(join(String(input.workspaceRoot), 'reproduce'));
  if (!reproduceDir.ok) return Result.error(reproduceDir.error);

  const session = await runReproduceSession(deps, opts, taskId, input.task, reproduceDir.value, abortSignal);
  if (!session.ok) return Result.error(session.error);
  const reproduction = session.value;
  if (reproduction === undefined) return Result.ok({});

  const verified = await verifyReproductionFails(deps, opts.cwd, reproduction.runCommand, abortSignal);
  if (verified.kind === 'fatal') return Result.error(verified.error);
  if (verified.kind === 'discarded') {
    log.warn(
      `reproduce command for task '${String(taskId)}' did not fail on re-run — a reproduction that passes proves nothing, discarding`,
      { taskId: String(taskId), runCommand: reproduction.runCommand }
    );
    return Result.ok({});
  }

  const checksum = await checksumTestFile(opts.cwd, reproduction.testPath);
  if (checksum === undefined) {
    log.warn(`reproduce test file unreadable for task '${String(taskId)}' — continuing without a reproduction`, {
      taskId: String(taskId),
      testPath: reproduction.testPath,
    });
    return Result.ok({});
  }

  const artifact: ReproductionArtifact = {
    testPath: reproduction.testPath,
    runCommand: reproduction.runCommand,
    observedFailure: verified.observedFailure,
    relevantTests: reproduction.relevantTests,
    checksum,
  };
  log.info(`reproduction verified for task '${String(taskId)}'`, {
    taskId: String(taskId),
    testPath: artifact.testPath,
  });
  return Result.ok({ artifact });
};

export const reproduceLeaf = (
  deps: ReproduceLeafDeps,
  opts: ReproduceLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, ReproduceInput, ReproduceOutput>(`reproduce-${String(taskId)}`, {
    useCase: {
      execute: async (input, signal) => reproduceUseCase(deps, opts, taskId, input, signal),
    },
    input: (ctx) => {
      const task = ctx.tasks?.find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-reproduce',
          attemptedAction: `reproduce-${String(taskId)}`,
          message: `reproduce-${String(taskId)}: task not found in ctx.tasks`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-reproduce',
          attemptedAction: `reproduce-${String(taskId)}`,
          message: `reproduce-${String(taskId)}: ctx.taskWorkspaceRoot is undefined — build-task-workspace must run first`,
        });
      }
      return { task, workspaceRoot: ctx.taskWorkspaceRoot };
    },
    output: (ctx, out) => (out.artifact !== undefined ? { ...ctx, reproductionArtifact: out.artifact } : ctx),
  });

/**
 * Unconditional per-task reset for `ctx.reproductionArtifact`, spliced immediately BEFORE the
 * `reproduce-guard-<taskId>` guard in `per-task-subchain.ts` — the guard itself only ever WRITES
 * a fresh artifact (or nothing, on a skip / degrade), so without this a defect-shaped task's
 * validated artifact would otherwise leak, unchanged, into every later task of the SAME serial
 * run that isn't itself defect-shaped (`reproductionArtifact` is classified `merge: 'per-task'`
 * in `sprint-scoped-projection.ts`, which already clears it between parallel-wave branches — this
 * leaf is the serial-path counterpart of that same per-task isolation). Trivial, synchronous, no
 * failure mode.
 */
export const clearReproductionArtifactLeaf = (taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, undefined, undefined>(`reset-reproduction-${String(taskId)}`, {
    useCase: {
      execute: async () => Result.ok(undefined),
    },
    input: () => undefined,
    output: (ctx) => ({ ...ctx, reproductionArtifact: undefined }),
  });
