import type { Task } from '@src/domain/entity/task.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

/**
 * Shared task-section renderers used by both the implement (P02) and evaluate (P03) prompt
 * definitions. The two templates surface identical task-shaped sections (description / steps
 * / verification criteria) plus the per-repo verify-script and project-tooling slots, so the
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

/**
 * Render the "## Done criteria" bullet list, or empty string when none declared.
 *
 * Each criterion renders on one line so operators can grep it on disk:
 *
 *   `- **[C1]** (auto) \`<command>\` — <assertion>`     (auto criteria)
 *   `- **[C2]** (manual) — <assertion>`                 (manual criteria)
 *
 * The "Done criteria" heading is stable on purpose so operators can grep `^## Done criteria`
 * across the per-round `prompt.md` files to see what the AI was held to per round.
 */
export const renderVerificationCriteriaSection = (task: Task): string => {
  if (task.verificationCriteria.length === 0) return '';
  const bullets = task.verificationCriteria
    .map((c) => {
      if (c.check === 'auto') {
        const cmd = c.command ?? '';
        return `- **[${c.id}]** (auto) \`${cmd}\` — ${c.assertion}`;
      }
      return `- **[${c.id}]** (manual) — ${c.assertion}`;
    })
    .join('\n');
  return `## Done criteria\n\n${bullets}`;
};

/**
 * Render the full per-task `contract.md` sidecar — written next to `prompt.md` by the
 * implement workspace leaf so both generator and evaluator (and any human auditor) can read
 * the authoritative definition of done in one place. The contract carries:
 *
 *  1. task name (level-1 heading)
 *  2. optional description (under `## Description`)
 *  3. the canonical criteria table — one row per criterion with id, check kind, command,
 *     and assertion
 *
 * The table form (rather than a bullet list) is deliberate: the evaluator's per-criterion
 * assessment block in `evaluation.md` mirrors the same column layout, so an operator can
 * diff the contract and the verdict side-by-side without rewrapping rows.
 */
export const renderContractMd = (task: Task): string => {
  const lines: string[] = [];
  lines.push(`# ${task.name}`);
  lines.push('');
  if (task.description !== undefined && task.description.trim().length > 0) {
    lines.push('## Description');
    lines.push('');
    lines.push(task.description.trim());
    lines.push('');
  }
  lines.push('## Criteria');
  lines.push('');
  if (task.verificationCriteria.length === 0) {
    lines.push('_No verification criteria declared._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| id | check | command | assertion |');
  lines.push('|---|---|---|---|');
  for (const c of task.verificationCriteria) {
    const cmd = c.check === 'auto' && c.command !== undefined ? `\`${c.command}\`` : '—';
    lines.push(`| ${c.id} | ${c.check} | ${cmd} | ${c.assertion} |`);
  }
  lines.push('');
  return lines.join('\n');
};

/**
 * Render the body of the "## Verify Script" section.
 *
 *  - With a configured command, embed it as a fenced shell block so the agent runs the exact
 *    command the harness will run as the post-task gate.
 *  - When undefined / empty, state explicitly that no verify script is configured. The
 *    surrounding template prose already tells the agent how to fall back; we don't repeat it.
 */
export const renderVerifyScriptSection = (verifyScript: string | undefined): string => {
  if (verifyScript === undefined) return 'No verify script configured for this repo.';
  const trimmed = verifyScript.trim();
  if (trimmed.length === 0) return 'No verify script configured for this repo.';
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
      `${String(floorCount + i + 1)}. **${name}** — grade PASS or FAIL on this task-specific aspect the planner attached to this task.`
  );
  return [
    '**Task-specific dimensions** (in addition to the floor dimensions above; same PASS / FAIL rule):',
    '',
    ...lines,
  ].join('\n');
};

/**
 * Render the subject-line suffix appended to per-task commit messages — the conventional
 * `feat(scope): subject (#123)` shape that GitHub renders as a clickable issue ref in `git
 * log` and on the PR timeline. Used today by `commit-task.ts`; the implement prompt no longer
 * carries any ref placeholder. PR-body-level auto-close on merge is handled separately by
 * `renderIssueRefs` in the create-pr prompt definition, which still injects `Closes #X` into
 * the PR body — keeping the suffix here purely subject-shaped means double-close lines never
 * land in `git log`.
 *
 * Format (leading space, parens, comma-space between refs):
 *   ` (#123)`              (single ref)
 *   ` (#123, !456)`        (multiple refs — comma-separated inside one paren)
 *
 * Empty / undefined → empty string. Refs are trimmed, deduped first-seen-wins, and emitted in
 * input order via {@link normalizeRefs}. The harness writes the ref tokens verbatim —
 * `#`/`!`/`PROJ-` decoration is the source ticket's choice, not ours to normalise.
 */
export const renderTicketRefsSubjectSuffix = (refs: readonly string[] | undefined): string => {
  const normalized = normalizeRefs(refs);
  if (normalized.length === 0) return '';
  return ` (${normalized.join(', ')})`;
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

/**
 * "Change your approach" directive injected when this task is a plateau-break attempt — i.e. the
 * gen-eval loop stalled (the same evaluator dimensions kept failing across rounds with no real
 * progress) and the escalation policy granted one more attempt. Empty when not a plateau-break
 * attempt. The point is to break the model out of iterating on a non-converging path: it is told
 * the previous strategy is stuck and to try a fundamentally different one, rather than nudging the
 * same diff again. Pairs with the Prior Critique section (which still carries the specific failing
 * dimensions). Generator-only — the evaluator never sees it (its rubric is held constant).
 */
export const renderPlateauDirectiveSection = (plateauBreak: boolean): string => {
  if (!plateauBreak) return '';
  return [
    '## ⚠ You have plateaued — change your approach',
    '',
    'Earlier attempts at this task stalled: the same checks kept failing across multiple rounds with',
    'no real progress. Do NOT keep iterating on the previous approach — that path is not converging.',
    'Step back and rethink. Re-read the task contract and the prior critique, question the assumption',
    'that led the earlier attempts astray, and implement a **fundamentally different** solution — a',
    'different design, data flow, or code path. Then verify the failing criteria directly before',
    'signalling completion.',
  ].join('\n');
};
