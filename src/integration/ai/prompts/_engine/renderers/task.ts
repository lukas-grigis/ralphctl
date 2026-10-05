import type { Task } from '@src/domain/entity/task.ts';
import { FLOOR_DIMENSIONS } from '@src/integration/ai/evaluation/_engine/floor-dimensions.ts';
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
 * placeholder; defaults to `FLOOR_DIMENSIONS.length` (the canonical rubric size) so the
 * numbering never drifts from the rendered `{{FLOOR_RUBRIC_SECTION}}` block.
 */
export const renderExtraDimensionsSection = (
  extras: readonly string[] | undefined,
  floorCount = FLOOR_DIMENSIONS.length
): string => {
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
 * `trajectory` is an optional pre-composed "## Dimension trajectory" block (built by
 * `composeDimensionTrajectory` from `ctx.plateauHistory`) carrying the failed-dimension feed-forward
 * — which dimensions were fixed / still failing for N rounds / newly failing, plus a change-approach
 * nudge once a dimension keeps failing. It rides INSIDE this section so no new template placeholder is needed: the generator
 * gets both the latest critique prose AND the multi-round trajectory in one block. Empty / absent →
 * not appended.
 *
 * Renders to empty string when there's neither a critique nor a trajectory so the template's
 * placeholder collapses without an orphan heading.
 */
export const renderPriorCritiqueSection = (critique: string | undefined, trajectory?: string): string => {
  const critiqueText = critique?.trim() ?? '';
  const trajectoryText = trajectory?.trim() ?? '';
  if (critiqueText.length === 0 && trajectoryText.length === 0) return '';

  const blocks: string[] = [];
  if (critiqueText.length > 0) {
    blocks.push(
      [
        '## Prior Critique',
        '',
        'The evaluator graded the previous attempt as **failed**. Address each dimension below before',
        'signalling completion — the same evaluator will re-grade this turn.',
        '',
        critiqueText,
      ].join('\n')
    );
  }
  if (trajectoryText.length > 0) blocks.push(trajectoryText);
  return blocks.join('\n\n');
};

// Blank / absent body renders nothing, so the slot collapses with no orphan wrapper tag.
export const renderTaggedBlock = (tag: string, body: string | undefined, preface: readonly string[] = []): string => {
  const trimmed = body?.trim() ?? '';
  if (trimmed.length === 0) return '';
  return [`<${tag}>`, ...(preface.length > 0 ? [...preface, ''] : []), trimmed, `</${tag}>`].join('\n');
};

/**
 * Render the optional generator-hints section passed to the evaluator. The hints carry same-round
 * generator observations — proposed commit subject, environment notes (dev-server ports, quirks),
 * learnings recorded during the generator turn. Only the wrapper and the raw hints are emitted here —
 * the adversarial framing (unverified claims, never evidence) lives in the evaluate templates so the
 * untrusted-data notice covers generator-authored text only.
 *
 * Empty / absent → empty string so the `{{GENERATOR_HINTS_SECTION}}` placeholder collapses without
 * leaving an orphan heading or XML-like tag in the rendered prompt.
 */
export const renderGeneratorHintsSection = (hints: string | undefined): string =>
  renderTaggedBlock('generator_hints', hints);

/**
 * Render the optional `<prior_attempts>` block — the most instructive prior attempts on this task
 * (select-K slice) with their verification outcomes. Empty / absent → `{{PRIOR_ATTEMPTS_SECTION}}`
 * collapses cleanly with no orphan wrapper.
 */
export const renderPriorAttemptsSection = (summary: string | undefined): string =>
  renderTaggedBlock('prior_attempts', summary);

/**
 * Render the generator-facing `<reproduction>` block — a failing test a prior `reproduce` session
 * wrote for this defect-shaped task. Empty / absent → `{{REPRODUCTION_SECTION}}` collapses cleanly.
 */
export const renderReproductionSection = (reproduction: string | undefined): string =>
  renderTaggedBlock('reproduction', reproduction, [
    'A failing reproduction test already exists for this task, written in an earlier session. Make it',
    'pass without weakening it — do not delete, skip, or loosen its assertions to reach a pass. It is',
    'uncommitted in the working tree on purpose; leave it there — the harness commits it with your work.',
  ]);

/** Structural shape of the restored-work context — typed here so the prompts module stays free of domain imports. */
export interface RestoredWorkContext {
  readonly stat?: { readonly files: number; readonly insertions: number; readonly deletions: number };
  readonly critique?: string;
}

/**
 * Render the body of the template's `<restored_work>` wrapper — an earlier, rejected attempt's
 * uncommitted changes the harness put back into the working tree. Absent → empty string.
 */
export const renderRestoredWorkSection = (restored: RestoredWorkContext | undefined): string => {
  if (restored === undefined) return '';
  const stat = restored.stat;
  const size =
    stat === undefined
      ? ''
      : ` — ${String(stat.files)} ${stat.files === 1 ? 'file' : 'files'}, +${String(stat.insertions)} -${String(stat.deletions)} lines`;
  const critique = restored.critique?.trim() ?? '';
  const intro = [
    'An earlier attempt at this task was rejected before it was committed. The harness set its uncommitted',
    `changes aside and has restored them into the working tree${size} — so those are the uncommitted changes`,
    'you will find. Treat them as a draft to check against the contract, not as accepted work: keep what',
    'serves the task, and rewrite or revert what does not.',
  ];
  if (critique.length === 0) {
    return [...intro, 'No critique of them was recorded — judge them against the contract alone.'].join('\n');
  }
  return [...intro, 'The critique that rejected them:', '', critique].join('\n');
};

/**
 * Render the optional pre-verify results block injected into the generator prompt. When the
 * harness ran a pre-task verification before spawning the generator, its output is injected here
 * so the generator can review the baseline state without re-running the verify script itself.
 *
 * Empty / absent → empty string so the `{{PRE_VERIFY_RESULTS}}` placeholder inside
 * `<pre_verify_results>…</pre_verify_results>` collapses without leaving a stale tag body in the
 * rendered prompt.
 */
export const renderPreVerifyResultsSection = (preVerifyOutput: string | undefined): string => {
  if (preVerifyOutput === undefined) return '';
  return preVerifyOutput.trim();
};

/**
 * Render the optional "## From prior sprints" section injected into the implement, plan and ideate
 * prompts (principle 3, read side). The body is a pre-composed bullet list of this project's
 * not-yet-promoted ledger entries — observed insights and deliberate decisions — built
 * application-side by `composePriorLearnings`. The heading is neutral: how to weigh each kind is
 * stated once in the consuming template, not here. Empty / absent → empty string so the
 * `{{PRIOR_LEARNINGS}}` placeholder collapses without an orphan heading.
 */
export const renderPriorLearningsSection = (priorLearnings: string | undefined): string => {
  if (priorLearnings === undefined) return '';
  const trimmed = priorLearnings.trim();
  if (trimmed.length === 0) return '';
  return ['## From prior sprints', '', trimmed].join('\n');
};

/**
 * Render the optional `<retry_feedback>` block injected into the generator prompt when a previous
 * attempt's harness post-verify failed — the failing command and a tail of its output. Empty /
 * absent → empty string, so no orphan wrapper tag or framing sentence reaches the prompt.
 */
export const renderRetryFeedbackSection = (retryFeedback: string | undefined): string =>
  renderTaggedBlock('retry_feedback', retryFeedback, [
    "A previous attempt's post-task verify failed — resolve this regression before any other work.",
  ]);

/**
 * Render the optional `<prior_criteria_verdicts>` block around the pre-composed per-criterion
 * checklist (`composeCriteriaHistory`). Empty / absent → empty string.
 */
export const renderPriorCriteriaVerdictsSection = (verdicts: string | undefined): string =>
  renderTaggedBlock('prior_criteria_verdicts', verdicts, [
    'Which done-criteria already pass. Keep those green; focus this round on the criteria still failing',
    'rather than re-proving what already passed.',
  ]);

/**
 * Render the optional "## Agent Definition" section appended strictly AFTER the base
 * `<role>`/`<success_criteria>` blocks in both the generator and evaluator prompts. This is the
 * seam a bound agent definition's persona/instructions render into — and, for a provider with no
 * native agent format, the in-session direct-fallback body. Because the placeholder always sits
 * after the base blocks, its content can only ADD instructions, never remove or override the base
 * role. Absent or empty → empty string so `{{AGENT_DEFINITION_SECTION}}` collapses without leaving
 * an orphan heading.
 */
export const renderAgentDefinitionSection = (agentDefinition: string | undefined): string => {
  if (agentDefinition === undefined) return '';
  const trimmed = agentDefinition.trim();
  if (trimmed.length === 0) return '';
  return ['## Agent Definition', '', trimmed].join('\n');
};

/**
 * "Change your approach" directive injected when this task is a plateau-break attempt — i.e. the
 * gen-eval loop stalled (the same evaluator dimensions kept failing across rounds) and the
 * escalation policy granted one more attempt. Empty when not a plateau-break attempt, so no empty
 * wrapper tag renders. Deliberately states no round counts or caps: the harness's loop budget is
 * not exposed to the generator. Pairs with the Prior Critique section (which still carries the
 * specific failing dimensions). Generator-only — the evaluator never sees it.
 */
export const renderPlateauDirectiveSection = (plateauBreak: boolean): string => {
  if (!plateauBreak) return '';
  return renderTaggedBlock(
    'plateau_directive',
    [
      '## You have plateaued — change your approach',
      '',
      'Earlier attempts at this task stalled: the same checks kept failing across multiple rounds with',
      'no real progress. Step back and rethink. Re-read the task contract and the prior critique, question',
      'the assumption that led the earlier attempts astray, and implement a **fundamentally different**',
      'solution — a different design, data flow, or code path. Then verify the failing criteria directly',
      'before signalling completion.',
      '',
      'Before you choose that different approach, name which failure mode you were stuck in —',
      're-exploring code you already understood, looping on the same failing edit, over-polishing',
      'criteria that already pass, or fixing the wrong location entirely — then change that specific',
      'behaviour, not just "try something different."',
    ].join('\n')
  );
};
