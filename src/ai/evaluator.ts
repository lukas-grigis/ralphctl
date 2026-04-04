import { getActiveProvider } from '@src/providers/index.ts';
import type { ProviderAdapter } from '@src/providers/types.ts';
import type { Task } from '@src/schemas/index.ts';
import { spawnWithRetry } from '@src/ai/session.ts';
import { buildEvaluatorPrompt, type EvaluatorPromptContext } from '@src/ai/prompts/index.ts';
import { getSprintDir } from '@src/utils/paths.ts';

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

export interface EvaluationResult {
  passed: boolean;
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
 */
export function parseEvaluationResult(output: string): EvaluationResult {
  const dimensions = parseDimensionScores(output);

  // Check for passed signal
  if (output.includes('<evaluation-passed>')) {
    return { passed: true, output, dimensions };
  }

  // Check for failed signal with critique
  const failedMatch = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/.exec(output);
  if (failedMatch) {
    return { passed: false, output: failedMatch[1]?.trim() ?? output, dimensions };
  }

  // No signal found — treat as failure
  return { passed: false, output, dimensions };
}

// ============================================================================
// Evaluator Context Building
// ============================================================================

/**
 * Build context for evaluator prompt.
 * Includes task spec and project path — evaluator investigates autonomously.
 * Check script is framed as a mandatory computational verification step.
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

  return {
    taskName: task.name,
    taskDescription: task.description ?? '',
    taskSteps: task.steps,
    verificationCriteria: task.verificationCriteria,
    projectPath: task.projectPath,
    checkScriptSection,
  };
}

// ============================================================================
// Evaluator Invocation
// ============================================================================

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
  provider?: ProviderAdapter
): Promise<EvaluationResult> {
  const p = provider ?? (await getActiveProvider());
  const evaluatorModel = getEvaluatorModel(generatorModel, p);
  const sprintDir = getSprintDir(sprintId);

  const ctx = buildEvaluatorContext(task, checkScript);
  const prompt = buildEvaluatorPrompt(ctx);

  // Build provider args (include evaluator model for Claude)
  const providerArgs: string[] = ['--add-dir', sprintDir];
  if (evaluatorModel && p.name === 'claude') {
    providerArgs.push('--model', evaluatorModel);
  }

  const result = await spawnWithRetry({
    cwd: task.projectPath,
    args: providerArgs,
    prompt,
    env: p.getSpawnEnv(),
  });

  return parseEvaluationResult(result.stdout);
}
