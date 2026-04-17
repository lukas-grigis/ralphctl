/**
 * Pure markdown builder for the per-task sprint contract.
 *
 * The contract consolidates everything the generator AND evaluator need
 * to agree on before work begins:
 *   - Task name + description + steps (the WHAT).
 *   - Verification criteria (the definition of "done").
 *   - Resolved checkScript for the task's `projectPath` (the cheap gate).
 *   - Evaluator dimensions (the grading rubric).
 *
 * The generator reads this before implementing; the evaluator reads the
 * same file before reviewing. Both sides work from one source of truth,
 * which is the harness-design pattern Anthropic's guidance recommends.
 *
 * Pure — no I/O, no filesystem. The step (`contract-negotiate`) handles
 * the write; this module handles the shape.
 */

import type { Task } from '@src/domain/models.ts';

/**
 * The four dimensions the evaluator scores on. Kept here (not in the
 * evaluator prompt) so the contract and any future dimension-emission
 * paths reference a single source. The prompt itself describes *how*
 * each dimension is assessed; this list is the authoritative set of
 * names.
 */
export const EVALUATOR_DIMENSIONS = ['Correctness', 'Completeness', 'Safety', 'Consistency'] as const;

export interface ContractContext {
  task: Task;
  /** Resolved check script for `task.projectPath`, or null if none is configured. */
  checkScript: string | null;
  /** Evaluator dimension names — defaults to {@link EVALUATOR_DIMENSIONS}. */
  evaluatorDimensions?: readonly string[];
}

export function buildContractMarkdown(ctx: ContractContext): string {
  const { task, checkScript } = ctx;
  const dimensions = ctx.evaluatorDimensions ?? EVALUATOR_DIMENSIONS;

  const sections: string[] = [];

  sections.push(`# Sprint Contract — ${task.name}`);
  sections.push('_Contract between the generator and evaluator. Both sides read this file before starting._');

  sections.push('## Task');
  sections.push(`**${task.name}**`);
  if (task.description) {
    sections.push(task.description);
  }

  if (task.steps.length > 0) {
    sections.push('## Steps');
    sections.push(task.steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n'));
  }

  // Verification criteria rendered as a checklist — the evaluator treats
  // each item as an independent gate in dimension assessment.
  sections.push('## Verification Criteria');
  if (task.verificationCriteria.length > 0) {
    sections.push(task.verificationCriteria.map((c) => `- [ ] ${c}`).join('\n'));
  } else {
    sections.push('_(none declared — the evaluator will rely on steps + description alone)_');
  }

  sections.push('## Check Script');
  if (checkScript) {
    // Compose the fenced block as a single section so the markdown joiner
    // doesn't insert blank lines inside the code fence.
    sections.push(`Resolved for \`${task.projectPath}\`:\n\n\`\`\`sh\n${checkScript}\n\`\`\``);
    sections.push(
      'This is the deterministic gate. The harness runs it post-task; the evaluator runs it during review.'
    );
  } else {
    sections.push(
      `_(no check script configured for \`${task.projectPath}\`)_\n\nThe evaluator will derive a verification command from \`CLAUDE.md\`, \`AGENTS.md\`, or \`package.json\`.`
    );
  }

  sections.push('## Evaluator Dimensions');
  sections.push('The evaluator scores these dimensions (PASS / FAIL):');
  sections.push(dimensions.map((d) => `- **${d}**`).join('\n'));

  sections.push('## Project Path');
  sections.push(`\`${task.projectPath}\``);

  return sections.join('\n\n') + '\n';
}
