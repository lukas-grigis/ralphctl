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

export interface EvaluationResult {
  passed: boolean;
  output: string;
}

/**
 * Parse evaluator AI output for evaluation signals.
 * Checks for <evaluation-passed> or <evaluation-failed>...</evaluation-failed>
 */
export function parseEvaluationResult(output: string): EvaluationResult {
  // Check for passed signal
  if (output.includes('<evaluation-passed>')) {
    return { passed: true, output };
  }

  // Check for failed signal with critique
  const failedMatch = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/.exec(output);
  if (failedMatch) {
    return { passed: false, output: failedMatch[1]?.trim() ?? output };
  }

  // No signal found — treat as failure
  return { passed: false, output };
}

// ============================================================================
// Evaluator Context Building
// ============================================================================

/**
 * Build context for evaluator prompt.
 * Includes task spec and project path — evaluator investigates autonomously.
 */
export function buildEvaluatorContext(task: Task, checkScript: string | null): EvaluatorPromptContext {
  const checkScriptSection = checkScript
    ? `## Check Script

You can run the following check script to verify the changes:

\`\`\`
${checkScript}
\`\`\`

Run it to gain additional insight into whether the implementation is correct.`
    : null;

  return {
    taskName: task.name,
    taskDescription: task.description ?? '',
    taskSteps: task.steps,
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
