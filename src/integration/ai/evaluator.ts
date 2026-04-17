import { getActiveProvider } from '@src/integration/ai/providers/registry.ts';
import type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';
import type { EvaluationStatus, Task } from '@src/domain/models.ts';
import { spawnWithRetry } from '@src/integration/ai/session.ts';
import { buildEvaluatorPrompt, type EvaluatorPromptContext } from '@src/integration/ai/prompts/loader.ts';
import { getSprintDir } from '@src/integration/persistence/paths.ts';
import { buildProjectToolingSection } from '@src/integration/ai/project-tooling.ts';
import type { RateLimitCoordinator } from '@src/integration/ai/rate-limiter.ts';

/**
 * Max agentic turns for the evaluator. Lower than the executor's 200 because
 * the evaluator's job is review, not implementation — runaway evaluator
 * sessions are pure cost with no upside.
 */
const EVALUATOR_MAX_TURNS = 100;

// Re-export so existing callers that imported from evaluator.ts keep working.
export type { EvaluationStatus };

// ============================================================================
// Model Ladder
// ============================================================================

/**
 * Get the evaluator model based on the generator's model.
 * Claude: Opus -> Sonnet, Sonnet -> Haiku, Haiku -> Haiku
 * Copilot: returns null (no model selection available)
 */
export function getEvaluatorModel(generatorModel: string | null, provider: ProviderAdapter): string | null {
  if (provider.name !== 'claude' || !generatorModel) return null;

  const modelLower = generatorModel.toLowerCase();
  if (modelLower.includes('opus')) return 'claude-sonnet-4-6';
  if (modelLower.includes('sonnet')) return 'claude-haiku-4-5';
  return 'claude-haiku-4-5'; // haiku or unknown -> haiku
}

// ============================================================================
// Evaluation Result Parsing
// ============================================================================

/** Evaluation dimensions scored by the evaluator. */
export type EvaluationDimension = 'correctness' | 'completeness' | 'safety' | 'consistency';

/** Per-dimension score parsed from evaluator output. */
export interface DimensionScore {
  dimension: EvaluationDimension;
  passed: boolean;
  finding: string;
}

/**
 * Discriminator semantics for `EvaluationStatus`:
 * - `passed`   — `<evaluation-passed>` signal present.
 * - `failed`   — `<evaluation-failed>` signal present, OR partial dimensions parsed but no signal.
 * - `malformed`— neither signal AND no dimension lines parsed (unusable evaluator output).
 *
 * The type itself lives in `src/schemas/index.ts` so the Zod schema is the
 * single source of truth for the enum members.
 */
export interface EvaluationResult {
  passed: boolean;
  status: EvaluationStatus;
  output: string;
  /** Per-dimension scores when structured assessment is present. */
  dimensions: DimensionScore[];
}

const DIMENSION_NAMES: EvaluationDimension[] = ['correctness', 'completeness', 'safety', 'consistency'];

/** Pre-compiled regexes for dimension score parsing — avoids re-creation per call. */
const DIMENSION_PATTERNS: Record<EvaluationDimension, RegExp> = {
  correctness: /\*\*correctness\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  completeness: /\*\*completeness\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  safety: /\*\*safety\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
  consistency: /\*\*consistency\*\*\s*:\s*(PASS|FAIL)\s*(?:—|-)\s*(.+)/i,
};

/**
 * Parse structured dimension scores from evaluator output.
 * Matches lines like: **Correctness**: PASS — one-line finding
 */
export function parseDimensionScores(output: string): DimensionScore[] {
  const scores: DimensionScore[] = [];

  for (const dim of DIMENSION_NAMES) {
    const match = DIMENSION_PATTERNS[dim].exec(output);
    if (match?.[1] && match[2]) {
      scores.push({
        dimension: dim,
        passed: match[1].toUpperCase() === 'PASS',
        finding: match[2].trim(),
      });
    }
  }

  return scores;
}

/**
 * Parse evaluator AI output for evaluation signals and dimension scores.
 * Checks for <evaluation-passed> or <evaluation-failed>...</evaluation-failed>.
 * Also extracts structured dimension scores when present.
 *
 * Returns `status: 'malformed'` only when BOTH signals are missing AND no
 * dimension lines parsed — that's the case where the evaluator output is
 * effectively unusable. A failed dimension assessment without a signal is
 * still treated as `failed` (the assessment carries enough signal on its own).
 */
export function parseEvaluationResult(output: string): EvaluationResult {
  const dimensions = parseDimensionScores(output);

  // Check for passed signal
  if (output.includes('<evaluation-passed>')) {
    return { passed: true, status: 'passed', output, dimensions };
  }

  // Check for failed signal with critique
  const failedMatch = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/.exec(output);
  if (failedMatch) {
    return { passed: false, status: 'failed', output: failedMatch[1]?.trim() ?? output, dimensions };
  }

  // No signal — but if dimensions parsed, we still have actionable data → 'failed'
  if (dimensions.length > 0) {
    return { passed: false, status: 'failed', output, dimensions };
  }

  // Neither signal nor dimensions: evaluator output is unusable
  return { passed: false, status: 'malformed', output, dimensions };
}

// ============================================================================
// Evaluator Context Building
// ============================================================================

/**
 * Build context for evaluator prompt.
 * Includes task spec and project path — evaluator investigates autonomously.
 * Check script is framed as a mandatory computational verification step.
 *
 * Detects project-installed tooling (subagents, skills, MCP servers,
 * instruction files) and renders a "Project Tooling" section telling the
 * evaluator to use them. Per the harness-design article, evaluators that
 * interact with the system via available tools catch issues that static
 * diff review misses — but only if they're explicitly told what's available.
 */
export function buildEvaluatorContext(task: Task, checkScript: string | null): EvaluatorPromptContext {
  const checkScriptSection = checkScript
    ? `## Check Script (Computational Gate)

Run this check script as the **first step** of your review — it is the same gate the harness uses post-task:

\`\`\`
${checkScript}
\`\`\`

If this script fails, the implementation fails regardless of code quality. Record the full output.`
    : null;

  const projectToolingSection = buildProjectToolingSection(task.projectPath);

  return {
    taskName: task.name,
    taskDescription: task.description ?? '',
    taskSteps: task.steps,
    verificationCriteria: task.verificationCriteria,
    projectPath: task.projectPath,
    checkScriptSection,
    projectToolingSection,
  };
}

// ============================================================================
// Evaluator Invocation
// ============================================================================

export interface RunEvaluationOptions {
  /**
   * Optional coordinator to participate in. When the parallel executor pauses
   * for a global rate limit, the evaluator must wait too — otherwise it can
   * spawn into a 429 wall and fail spuriously.
   */
  coordinator?: RateLimitCoordinator;
  /** Max rate-limit retries forwarded to spawnWithRetry. */
  maxRetries?: number;
}

/**
 * Run evaluation on a completed task.
 * Spawns an autonomous evaluator session with tool access.
 * Evaluator investigates the changes and returns a pass/fail verdict.
 */
export async function runEvaluation(
  task: Task,
  generatorModel: string | null,
  checkScript: string | null,
  sprintId: string,
  provider?: ProviderAdapter,
  options?: RunEvaluationOptions
): Promise<EvaluationResult> {
  const p = provider ?? (await getActiveProvider());
  const evaluatorModel = getEvaluatorModel(generatorModel, p);
  const sprintDir = getSprintDir(sprintId);

  const ctx = buildEvaluatorContext(task, checkScript);
  const prompt = buildEvaluatorPrompt(ctx);

  // Build provider args. Claude-only flags: model + max-turns.
  const providerArgs: string[] = ['--add-dir', sprintDir];
  if (p.name === 'claude') {
    if (evaluatorModel) {
      providerArgs.push('--model', evaluatorModel);
    }
    // Cap evaluator turns — autonomous evaluators can spiral on noisy diffs
    providerArgs.push('--max-turns', String(EVALUATOR_MAX_TURNS));
  }

  // Wait if a coordinator is paused (parallel executor only)
  await options?.coordinator?.waitIfPaused();

  // spawnWithRetry already defaults maxRetries to DEFAULT_MAX_RETRIES when
  // undefined — no need for a conditional guard here.
  const result = await spawnWithRetry(
    {
      cwd: task.projectPath,
      args: providerArgs,
      prompt,
      env: p.getSpawnEnv(),
    },
    { maxRetries: options?.maxRetries },
    p
  );

  return parseEvaluationResult(result.stdout);
}
