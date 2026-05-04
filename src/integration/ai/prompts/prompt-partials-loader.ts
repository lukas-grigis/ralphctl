import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { substitute } from './placeholder-substitution.ts';
import { TEMPLATE_NAMES } from './prompt-template-names.ts';
import type { TemplateLoader } from './template-loader.ts';

/**
 * Neutral, ecosystem-agnostic check-gate example. Pre-expanded inside
 * the planner partials so generated `steps` / `verificationCriteria`
 * examples don't leak Node-specific commands (`pnpm test`) to prompts
 * that run in Python / Go / Rust / Java / mixed repos. Downstream
 * projects supply the real command via `{{PROJECT_TOOLING}}` at runtime.
 */
export const CHECK_GATE_EXAMPLE =
  "Run the project's check gate — all pass (omit this step when the project has no check script)";

/**
 * Load the harness-context partial and the matching signals partial.
 * Used by `buildEvaluatePrompt` (`'evaluation'`) and
 * `buildFeedbackPrompt` (`'task'`) — both templates only need the two
 * shared partials, not the full planner bundle.
 *
 * Pre-fixing the bug where these methods emitted empty strings: the
 * substitute helper is single-pass and fail-soft, so an empty
 * `{{SIGNALS}}` substitution results in a stray placeholder reaching
 * the AI rather than throwing.
 */
export async function loadHarnessAndSignals(
  loader: TemplateLoader,
  kind: 'evaluation' | 'task' | 'planning'
): Promise<Result<{ harness: string; signals: string }, StorageError>> {
  const signalsName =
    kind === 'evaluation'
      ? TEMPLATE_NAMES.signalsEvaluation
      : kind === 'task'
        ? TEMPLATE_NAMES.signalsTask
        : TEMPLATE_NAMES.signalsPlanning;
  const [harness, signals] = await Promise.all([loader.load(TEMPLATE_NAMES.harnessContext), loader.load(signalsName)]);
  if (!harness.ok) return Result.error(harness.error);
  if (!signals.ok) return Result.error(signals.error);
  return Result.ok({ harness: harness.value, signals: signals.value });
}

/**
 * Load the four planner partials and pre-substitute their inner
 * placeholders so they drop cleanly into the outer plan template. The
 * `plan-common.md` partial nests `{{PLAN_COMMON_EXAMPLES}}`,
 * `{{PROJECT_TOOLING}}` and `{{CHECK_GATE_EXAMPLE}}` — those have to be
 * resolved before `COMMON` is itself substituted into the outer
 * template, otherwise we get unresolved tokens reaching the AI.
 */
export async function loadPlannerPartials(
  loader: TemplateLoader,
  projectToolingSection: string
): Promise<Result<{ harness: string; common: string; validation: string; signals: string }, StorageError>> {
  const [harness, planCommon, planExamples, validation, signals] = await Promise.all([
    loader.load(TEMPLATE_NAMES.harnessContext),
    loader.load(TEMPLATE_NAMES.planCommon),
    loader.load(TEMPLATE_NAMES.planCommonExamples),
    loader.load(TEMPLATE_NAMES.validationChecklist),
    loader.load(TEMPLATE_NAMES.signalsPlanning),
  ]);
  for (const r of [harness, planCommon, planExamples, validation, signals]) {
    if (!r.ok) return Result.error(r.error);
  }
  if (!harness.ok || !planCommon.ok || !planExamples.ok || !validation.ok || !signals.ok) {
    return Result.error(
      new StorageError({ subCode: 'io', message: 'failed to load planner partials (defensive guard)' })
    );
  }
  // The examples partial has its own {{CHECK_GATE_EXAMPLE}} marker.
  // `substitute` is a single regex pass, so any placeholder inside an
  // injected value is NOT re-scanned. Pre-substitute the examples
  // before they land in plan-common, otherwise the outer prompt emits
  // a literal {{CHECK_GATE_EXAMPLE}} to Claude.
  const examplesResolved = substitute(planExamples.value, { CHECK_GATE_EXAMPLE });
  const common = substitute(planCommon.value, {
    PLAN_COMMON_EXAMPLES: examplesResolved,
    PROJECT_TOOLING: projectToolingSection,
    CHECK_GATE_EXAMPLE,
  });
  return Result.ok({
    harness: harness.value,
    common,
    validation: validation.value,
    signals: signals.value,
  });
}
