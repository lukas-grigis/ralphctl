import type { Task } from '@src/domain/entity/task.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

/**
 * Shared task-section renderers used by both the implement (P02) and evaluate (P03) prompt
 * definitions. The two templates surface identical task-shaped sections (description / steps
 * / verification criteria) plus the per-repo check-script and project-tooling slots, so the
 * renderers live here once instead of being duplicated. Each helper produces an empty string
 * for the "absent" branch so the surrounding template collapses cleanly without leaving an
 * orphan heading.
 */

/**
 * Render the optional "## Description" section. Empty / whitespace-only descriptions render
 * as the empty string so the placeholder collapses cleanly without leaving an orphan heading.
 */
export const renderTaskDescriptionSection = (task: Task): string => {
  const desc = task.description;
  if (desc === undefined || desc.trim().length === 0) return '';
  return `## Description\n\n${desc.trim()}`;
};

/**
 * Render the "## Implementation Steps" numbered list. Empty steps array → empty string. The
 * planner currently emits at least one step on every task, but the renderer stays defensive
 * so a malformed plan doesn't sprout a stray header.
 */
export const renderTaskStepsSection = (task: Task): string => {
  if (task.steps.length === 0) return '';
  const numbered = task.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n');
  return `## Implementation Steps\n\n${numbered}`;
};

/** Render the "## Verification Criteria" bullet list, or empty string when none declared. */
export const renderVerificationCriteriaSection = (task: Task): string => {
  if (task.verificationCriteria.length === 0) return '';
  const bullets = task.verificationCriteria.map((c) => `- ${c}`).join('\n');
  return `## Verification Criteria\n\n${bullets}`;
};

/**
 * Render the body of the "## Check Script" section.
 *
 *  - With a configured command, embed it as a fenced shell block so the agent runs the exact
 *    command the harness will run as the post-task gate.
 *  - When undefined / empty, state explicitly that no check script is configured. The
 *    surrounding template prose already tells the agent how to fall back; we don't repeat it.
 */
export const renderCheckScriptSection = (checkScript: string | undefined): string => {
  if (checkScript === undefined) return 'No check script configured for this repo.';
  const trimmed = checkScript.trim();
  if (trimmed.length === 0) return 'No check script configured for this repo.';
  return ['The harness will run this command as the post-task gate:', '', '```sh', trimmed, '```'].join('\n');
};

/**
 * Render the "## Project Tooling" section body. The chain factory injects the rendered
 * tooling string (subagent / skill / MCP detection is application-layer); this helper just
 * trims and falls back to the standard "(none detected)" placeholder so the template never
 * emits a bare header.
 */
export const renderProjectToolingSection = (projectTooling: string | undefined): string => {
  if (projectTooling === undefined) return '_(none detected)_';
  const trimmed = projectTooling.trim();
  return trimmed.length === 0 ? '_(none detected)_' : trimmed;
};

/**
 * Render the optional "Task-specific dimensions" block appended to the evaluator's rubric. The
 * planner emits extras when a task has properties the floor dimensions don't capture well
 * (e.g. `accessibility`, `performance`, `migration-safety`). Each extra renders as one numbered
 * line starting at `<floor count> + 1` so the evaluator sees a single continuous rubric.
 *
 * Empty / absent → empty string so the template placeholder collapses without leaving an
 * orphan heading. `floorCount` is the number of floor dimensions already listed above the
 * placeholder; defaults to 4 to match the canonical rubric.
 */
export const renderExtraDimensionsSection = (extras: readonly string[] | undefined, floorCount = 4): string => {
  if (extras === undefined || extras.length === 0) return '';
  const lines = extras.map(
    (name, i) =>
      `${String(floorCount + i + 1)}. **${name}** — score on this task-specific aspect the planner attached to this task.`
  );
  return [
    '**Task-specific dimensions** (in addition to the floor dimensions above; same 1–5 rubric):',
    '',
    ...lines,
  ].join('\n');
};

/**
 * Render the closing-keyword trailer block appended to per-task commit messages. GitHub and
 * GitLab both parse `Closes <ref>` (case-insensitive) and auto-close the referenced issue
 * when the PR / MR merges, so one line per ref is what both platforms expect. Used today by
 * `commit-task.ts`; the implement prompt no longer carries the trailer placeholder.
 *
 * Format:
 *   `Closes #123`                       (single ref)
 *   `Closes #123\nCloses #456`          (multiple refs — one keyword per line)
 *
 * Empty / undefined → empty string. Refs are trimmed, deduped first-seen-wins, and emitted in
 * input order via {@link normalizeRefs}. The harness writes the ref tokens verbatim —
 * `#`/`!`/`PROJ-` decoration is the source ticket's choice, not ours to normalise.
 */
export const renderTicketRefsSection = (refs: readonly string[] | undefined): string => {
  const normalized = normalizeRefs(refs);
  if (normalized.length === 0) return '';
  return normalized.map((r) => `Closes ${r}`).join('\n');
};

/**
 * Render the optional "## Prior Critique" section — populated on turn 2+ of the gen-eval loop
 * with the evaluator's failed-verdict critique from the previous turn. The generator reads it
 * to know exactly which dimensions to address on the fix attempt. Absent on turn 1 (no prior
 * critique exists) and on `passed`/`malformed`/`plateau` exits (loop has already terminated).
 *
 * Renders to empty string when there's no critique so the template's placeholder collapses
 * without an orphan heading.
 */
export const renderPriorCritiqueSection = (critique: string | undefined): string => {
  if (critique === undefined) return '';
  const trimmed = critique.trim();
  if (trimmed.length === 0) return '';
  return [
    '## Prior Critique',
    '',
    'The evaluator graded the previous attempt as **failed**. Address each dimension below before',
    'signalling completion — the same evaluator will re-grade this turn.',
    '',
    trimmed,
  ].join('\n');
};
