import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type {
  CorrectiveRetryDeps,
  CorrectiveRetryOutcome,
} from '@src/integration/ai/contract/_engine/corrective-retry.ts';
import { validateSignalsFileWithCorrectiveRetry } from '@src/integration/ai/contract/_engine/corrective-retry.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { EvalFlow } from '../fixture-schema.ts';
import type { CandidateOrder } from '../grade.ts';
import type { ScriptedSignal } from '../fake-provider.ts';
import type { Fixture, Grade, ResolvedRow } from '../types.ts';
import type { Workspace } from '../workspace.ts';

/**
 * The seam between the generic trial runner and one flow. An adapter owns exactly the parts that
 * differ per flow: how to build the prompt + session from the SHIPPED builders (so the harness
 * measures what ships), and how to grade the outcome. Everything else — isolation, spawn,
 * corrective validation, usage, artifacts — lives once in `run-trial.ts`.
 */

/** One trial slot for a fixture: a variant to materialize (evaluate) or a candidate order (select). */
export interface TrialPlan {
  /** Variant name; for select-candidate the order (`ab` / `ba`). */
  readonly variant: string;
  readonly order?: CandidateOrder;
  /** Patch (relative to the fixture dir) applied uncommitted after the base commit. */
  readonly patchRel?: string;
  readonly defectClass?: string;
}

export interface GradeToolbox {
  readonly git: GitRunner;
  readonly shell: ShellScriptRunner;
  readonly tmpRoot?: string;
}

export interface TrialContext {
  readonly fixture: Fixture;
  readonly plan: TrialPlan;
  readonly workspace: Workspace;
  readonly row: ResolvedRow;
  readonly loader: TemplateLoader;
  /** Where this trial's graded artifacts (`oracle.txt`, …) land; created by the runner. */
  readonly artifactDir: AbsolutePath;
  readonly toolbox: GradeToolbox;
  readonly abortSignal?: AbortSignal;
}

/** Corrective-retry dependencies minus the parts the runner owns (`reinvoke`, `logger`, retry count). */
export type ValidateDeps = CorrectiveRetryDeps;

export interface PreparedTrial {
  readonly session: AiSession;
  /** Directory the AI writes `signals.json` into — also holds `prompt.md` / `body.txt`. */
  readonly outputDir: AbsolutePath;
  readonly selfContainedContext: string;
  /**
   * Whether production nudges this flow's invalid `signals.json` with corrective resumed spawns.
   * evaluate and implement do (`validateSignalsFileWithCorrectiveRetry`); detect-scripts and the
   * best-of-N judge call plain `validateSignalsFile` and fall back or error, so their trials run
   * with zero nudges — a nudge-rescued verdict would be one production discards.
   */
  readonly nudges: boolean;
  readonly validate: (deps: ValidateDeps) => Promise<Result<CorrectiveRetryOutcome<AiSignal>, DomainError>>;
}

export interface TrialOutcome {
  /** `signals.json` validated (possibly after nudges). */
  readonly valid: boolean;
  readonly signals: readonly AiSignal[];
}

export interface FlowAdapter {
  readonly flow: EvalFlow;
  /** The trial slots one fixture expands to; the runner repeats each `k` times. */
  plans(fixture: Fixture): readonly TrialPlan[];
  prepare(ctx: TrialContext): Promise<Result<PreparedTrial, DomainError>>;
  grade(ctx: TrialContext, outcome: TrialOutcome): Promise<Result<Grade, DomainError>>;
  /**
   * `--dry-run` answer: the signals a perfect model would emit, plus an optional side effect on the
   * workspace (e.g. applying the reference patch). Never used by live runs.
   */
  dryRun(
    ctx: TrialContext
  ): Promise<{ readonly signals: readonly ScriptedSignal[]; readonly sideEffect?: () => Promise<void> }>;
}

/**
 * Bind a per-flow contract into the runner's contract-agnostic `validate` — the same
 * `validateSignalsFileWithCorrectiveRetry` production uses, with the signal sub-union widened to
 * `AiSignal` (`TSig` is always a subset of it).
 */
export const validateWith =
  <TSig extends AiSignal>(contract: AiOutputContract<TSig>): PreparedTrial['validate'] =>
  async (deps) => {
    const validated = await validateSignalsFileWithCorrectiveRetry(deps, contract);
    if (!validated.ok) return Result.error(validated.error);
    return Result.ok({
      signals: validated.value.signals as readonly AiSignal[],
      nudgeCount: validated.value.nudgeCount,
    });
  };
