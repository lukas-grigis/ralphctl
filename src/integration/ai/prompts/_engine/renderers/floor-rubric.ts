import { FLOOR_DIMENSIONS } from '@src/integration/ai/evaluation/_engine/floor-dimensions.ts';

/**
 * Render the `{{FLOOR_RUBRIC_SECTION}}` markdown block shared by the evaluate and
 * evaluate-continuation templates. Single-sourced from {@link FLOOR_DIMENSIONS} — the same list
 * the evaluation schema (`signals/evaluation/schema.ts`) reads for its floor-coverage check — so
 * the rubric the evaluator is shown and the rule the harness validates against can never drift
 * apart.
 *
 * Each floor renders as one self-contained numbered block: the dimension's canonical rationale
 * (why the floor matters and what to check, verbatim from `FloorDimension.description`) followed
 * by its PASS / FAIL verdict rule — rationale before verdict, every floor. A shared preamble
 * anchors the verdict to the task's acceptance criteria in `<task_specification>` and the
 * check/verify output gathered in Phase 1, and tells the evaluator to note — never fabricate —
 * reference material that is missing or empty.
 */
export const renderFloorRubricSection = (): string => {
  const preamble = [
    `Every evaluation grades ${String(FLOOR_DIMENSIONS.length)} floor dimensions. Each dimension is independent; a FAIL on any one forces \`status: "failed"\` regardless of how other dimensions score.`,
    '',
    'Ground every verdict in the acceptance criteria listed in `<task_specification>` and the check/verify command output you gather in Phase 1 — cite them directly rather than asserting from memory. When `<task_specification>` or the check/verify output is missing or empty for this task, say so explicitly in the finding; never fabricate criteria or results that were not provided.',
  ].join('\n');

  const blocks = FLOOR_DIMENSIONS.map(
    (dimension, index) =>
      `${String(index + 1)}. **${dimension.name}** — ${dimension.description}\n\n   **Verdict:** PASS when every check above holds, each backed by a concrete observation (file path, line, function, tool output, or quoted snippet); FAIL when any check fails, or a PASS claim lacks evidence.`
  );

  return [preamble, '', blocks.join('\n\n')].join('\n');
};
