import type { Task } from '@src/domain/entity/task.ts';
import { FLOOR_DIMENSIONS } from '@src/integration/ai/evaluation/_engine/floor-dimensions.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

/**
 * Task-section renderers shared by the implement and evaluate prompt definitions. Every optional
 * section renders as `''` when its input is absent or blank, so the template placeholder collapses
 * without leaving an orphan heading or wrapper tag.
 */

const renderHeadedSection = (heading: string, body: string | undefined): string => {
  const trimmed = body?.trim() ?? '';
  return trimmed.length === 0 ? '' : `${heading}\n\n${trimmed}`;
};

export const renderTaskDescriptionSection = (task: Task): string =>
  renderHeadedSection('## Description', task.description);

/** Defensive on an empty list, so a malformed plan doesn't sprout a stray header. */
export const renderTaskStepsSection = (task: Task): string => {
  if (task.steps.length === 0) return '';
  const numbered = task.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n');
  return `## Implementation Steps\n\n${numbered}`;
};

/**
 * One line per criterion, under a heading kept stable so operators can grep `^## Done criteria`
 * across the per-round `prompt.md` files.
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
 * The per-task `contract.md` sidecar beside `prompt.md`: the authoritative definition of done for
 * generator, evaluator and human auditor. A table, not bullets, because `evaluation.md` mirrors its
 * columns so contract and verdict diff side by side.
 */
export const renderContractMd = (task: Task): string => {
  const lines: string[] = [];
  lines.push(`# ${task.name}`);
  lines.push('');
  const description = renderTaskDescriptionSection(task);
  if (description.length > 0) lines.push(description, '');
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

/** The exact post-task gate command as a fenced block; the template prose covers the no-script fallback. */
export const renderVerifyScriptSection = (verifyScript: string | undefined): string => {
  const trimmed = verifyScript?.trim() ?? '';
  if (trimmed.length === 0) return 'No verify script configured for this repo.';
  return ['The harness will run this command as the post-task gate:', '', '```sh', trimmed, '```'].join('\n');
};

/** These two sections always render a body, so the template never emits a bare header. */
export const renderProjectToolingSection = (projectTooling: string | undefined): string =>
  projectTooling?.trim() || '_(none detected)_';

/**
 * Planner-attached extra rubric dimensions, numbered on from the floor dimensions so the evaluator
 * sees one continuous rubric. `floorCount` defaults to `FLOOR_DIMENSIONS.length` so the numbering
 * never drifts from `{{FLOOR_RUBRIC_SECTION}}`.
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
 * Commit-subject suffix ` (#123, !456)` — clickable in `git log`. Subject-shaped on purpose: the PR
 * body carries `Closes #X` (create-pr's `renderIssueRefs`), so close lines never land in history.
 * Ref tokens are written verbatim, deduped first-seen-wins via {@link normalizeRefs}.
 */
export const renderTicketRefsSubjectSuffix = (refs: readonly string[] | undefined): string => {
  const normalized = normalizeRefs(refs);
  if (normalized.length === 0) return '';
  return ` (${normalized.join(', ')})`;
};

/**
 * The previous turn's failed-verdict critique (turn 2+ of the gen-eval loop), followed by the
 * optional pre-composed "## Dimension trajectory" block (`composeDimensionTrajectory`), which rides
 * inside this section rather than needing a placeholder of its own.
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
 * Same-round generator observations for the evaluator. Only the wrapper is emitted here; the
 * "unverified claims, never evidence" framing lives in the evaluate templates.
 */
export const renderGeneratorHintsSection = (hints: string | undefined): string =>
  renderTaggedBlock('generator_hints', hints);

/** The most instructive prior attempts (select-K slice) with their verification outcomes. */
export const renderPriorAttemptsSection = (summary: string | undefined): string =>
  renderTaggedBlock('prior_attempts', summary);

/** A failing test a prior `reproduce` session wrote for this defect-shaped task. */
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

/** An earlier, rejected attempt's uncommitted changes the harness put back into the working tree. */
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
    return renderTaggedBlock(
      'restored_work',
      [...intro, 'No critique of them was recorded — judge them against the contract alone.'].join('\n')
    );
  }
  return renderTaggedBlock('restored_work', [...intro, 'The critique that rejected them:', '', critique].join('\n'));
};

/** The pre-task verify output, so the generator sees the baseline without re-running the script. */
export const renderPreVerifyResultsSection = (preVerifyOutput: string | undefined): string =>
  preVerifyOutput?.trim() ?? '';

/**
 * This project's not-yet-promoted ledger entries (`composePriorLearnings`). The heading is neutral:
 * how to weigh each kind is stated once in the consuming template.
 */
export const renderPriorLearningsSection = (priorLearnings: string | undefined): string =>
  renderHeadedSection('## From prior sprints', priorLearnings);

/** A previous attempt's failing post-verify command and the tail of its output. */
export const renderRetryFeedbackSection = (retryFeedback: string | undefined): string =>
  renderTaggedBlock('retry_feedback', retryFeedback, [
    "A previous attempt's post-task verify failed — resolve this regression before any other work.",
  ]);

/** The pre-composed per-criterion checklist (`composeCriteriaHistory`). */
export const renderPriorCriteriaVerdictsSection = (verdicts: string | undefined): string =>
  renderTaggedBlock('prior_criteria_verdicts', verdicts, [
    'Which done-criteria already pass. Keep those green; focus this round on the criteria still failing',
    'rather than re-proving what already passed.',
  ]);

/**
 * A bound agent definition's persona / instructions. The placeholder sits AFTER the base `<role>` /
 * `<success_criteria>` blocks, so its content can only add instructions, never override the role.
 */
export const renderAgentDefinitionSection = (agentDefinition: string | undefined): string =>
  renderHeadedSection('## Agent Definition', agentDefinition);

/**
 * Generator-only "change your approach" directive for a plateau-break attempt. Deliberately states
 * no round counts or caps: the loop budget is not exposed to the generator.
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
