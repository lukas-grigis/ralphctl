import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

// ───────────────────────── ticket renderers ─────────────────────────

export function renderTicket(ticket: Ticket): string {
  // Project is sprint-level context after sprint-per-project — we no longer
  // re-state it per ticket. The refine prompt is implementation-agnostic
  // and doesn't need to know which project the ticket lives in.
  const lines: string[] = [`**Title:** ${ticket.title}`, `**ID:** ${ticket.id}`];
  if (ticket.link !== undefined) lines.push(`**Link:** ${ticket.link}`);
  if (ticket.description !== undefined) {
    lines.push('', '**Description:**', '', ticket.description);
  }
  return lines.join('\n');
}

function renderIssueContext(ticket: Ticket): string {
  // Mirror the legacy convention: when the ticket carries an upstream
  // link, emit a canonical <context>...</context> wrapper so downstream
  // prompt readers can spot it. No link → empty section.
  return ticket.link === undefined ? '' : `<context>\n\nUpstream issue: ${ticket.link}\n\n</context>`;
}

/**
 * Pick the right `<context>...</context>` block for the prompt:
 *  - Caller-supplied `issueContext` (the chain leaf pre-fetched via
 *    `ExternalPort.fetchIssue` + `formatIssueContext`) → wrap as-is.
 *  - Otherwise fall back to the bare-link rendering (or empty when no link).
 */
export function renderIssueContextSection(ticket: Ticket, issueContext: string | undefined): string {
  if (issueContext !== undefined && issueContext.trim().length > 0) {
    return `<context>\n\n${issueContext.trim()}\n\n</context>`;
  }
  return renderIssueContext(ticket);
}

// ───────────────────────── task renderers ─────────────────────────

/**
 * Render the feedback prompt's `{{COMPLETED_TASKS}}` block. The list is
 * context-only — the AI's authoritative instruction is the feedback
 * text. Empty input renders a "_(no tasks completed)_" placeholder so
 * the section doesn't collapse to a stray header in the prompt.
 */
export function renderCompletedTasks(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '_(no tasks completed)_';
  const lines: string[] = [];
  for (const t of tasks) {
    lines.push(`- **${t.name}** (\`${String(t.id)}\`)`);
    if (t.description !== undefined && t.description.trim().length > 0) {
      lines.push(`  - ${t.description.trim()}`);
    }
    lines.push(`  - project: \`${String(t.projectPath)}\``);
  }
  return lines.join('\n');
}

/**
 * Render the `## Check Script` section body for the execute prompt.
 *
 *  - When the chain supplies a `checkScript`, embed it as a fenced shell
 *    block so the agent sees the exact command the harness will run as
 *    the post-task gate.
 *  - When undefined / empty, state explicitly that no check script is
 *    configured for this repo — the prompt's Phase 1 / Phase 3 prose
 *    already tells the agent how to fall back (consult project
 *    instructions / run smoke commands), so we don't repeat the
 *    fallback advice here.
 */
export function renderCheckScriptSection(checkScript: string | undefined): string {
  if (checkScript === undefined) return 'No check script configured for this repo.';
  const trimmed = checkScript.trim();
  if (trimmed.length === 0) return 'No check script configured for this repo.';
  return ['The harness will run this command as the post-task gate:', '', '```sh', trimmed, '```'].join('\n');
}

/**
 * Render the evaluator prompt's `{{EVALUATE_WORKSPACE}}` section. When
 * the per-task chain laid down an evaluate workspace (refined
 * requirements, full task plan with sibling verdicts inlined,
 * dimensions, project context), the section points the evaluator at the
 * on-disk paths so the AI reads them via its file-read tool — cheaper
 * per round than inlining everything into the prompt. When undefined
 * (standalone `sprint evaluate` with no workspace), the section
 * collapses to ''.
 */
export function renderEvaluateWorkspaceSection(workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.trim().length === 0) return '';
  return [
    '## Contract files',
    '',
    `Upstream contract files for this task are mounted at \`${workspaceDir}\`. Read them as needed:`,
    '',
    '- `task.md` — the current task being evaluated (description, steps, verification criteria, status)',
    '- `requirements/<ticket-id>.md` — the refined requirements + raw ticket text that motivated this task',
    "- `tasks.md` — the full task plan, including any sibling tasks' evaluator output rendered inline where present (cross-task consistency + quality bar so far)",
    "- `project-context.md` — the project's CLAUDE.md / .github/copilot-instructions.md (when present in the target repo)",
    '- `dimensions.md` — the four floor dimensions plus any extra dimensions the planner emitted on this task',
  ].join('\n');
}

/**
 * Render the evaluator prompt's `{{DONE_CRITERIA_SECTION}}` slot.
 *
 * When a `doneCriteriaBullet` is supplied (read from the per-task
 * `done-criteria.md` in the execution unit), the section names the
 * bullet explicitly so the evaluator has a stable, human-readable
 * definition of "done" for THIS task. When the bullet is absent (legacy
 * sprint, missing file, or standalone `sprint evaluate` with no workspace)
 * the section collapses to an empty string — no orphan heading is emitted.
 */
export function renderDoneCriteriaSection(doneCriteriaBullet: string | undefined): string {
  const bullet = doneCriteriaBullet?.trim();
  if (bullet === undefined || bullet.length === 0) return '';
  return [
    '## Per-task done criteria',
    '',
    'The full feature list, one bullet per task, lives at `done-criteria.md`. The bullet for THIS task is:',
    '',
    bullet,
  ].join('\n');
}

// ───────────────────────── sprint renderers ─────────────────────────

export function renderRepositories(sprint: Sprint): string {
  // Sprint-per-project: repos live on the sprint, not on individual
  // tickets. `sprint plan` records the user's selection via
  // `Sprint.setAffectedRepositories`; the ideate flow reads it directly.
  if (sprint.affectedRepositories.length === 0) return '(no repositories selected)';
  return sprint.affectedRepositories.map((p) => `- ${String(p)}`).join('\n');
}

/**
 * Sprint-level affected repos — `sprint plan` records the user's
 * selection on the sprint aggregate. The planner inspects this set
 * when populating `{{PROJECT_TOOLING}}`.
 */
export function collectAffectedRepoPaths(sprint: Sprint): readonly AbsolutePath[] {
  return sprint.affectedRepositories;
}

/**
 * Render the plan prompt's `{{CONTEXT}}` block — sprint identity,
 * project, sprint-level repos, a quick-reference ticket index, and the
 * prior task set when this is a replan.
 *
 * Ticket REQUIREMENTS BODIES are NOT inlined here — they live in the
 * canonical `./requirements.json` aggregate the harness stages inside
 * the planning sandbox. The plan prompt template tells the AI to read
 * that file for the full requirements; the index below just lets the
 * AI cross-reference titles to ids without opening the JSON.
 */
export function renderPlanContext(sprint: Sprint, existingTasks: readonly Task[]): string {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprint.name}`);
  lines.push('', `Sprint ID: ${String(sprint.id)}`);
  lines.push('', `Project: ${String(sprint.projectName)}`);

  // Sprint-level affected repos. After sprint-per-project, the user's
  // checkbox selection is recorded on the sprint aggregate (not per
  // ticket), so the planner reads them directly here.
  if (sprint.affectedRepositories.length > 0) {
    lines.push('', '## Repositories');
    for (const r of sprint.affectedRepositories) lines.push(`- ${String(r)}`);
  }

  // Approved-ticket index — id + title only. Full bodies are in
  // `./requirements.json` inside the planning sandbox.
  const approved = sprint.tickets.filter((t) => t.requirementStatus === 'approved');
  if (approved.length > 0) {
    lines.push('', '## Approved Tickets (full requirements in `./requirements.json`)');
    for (const t of approved) lines.push(`- [${String(t.id)}] ${t.title}`);
  } else {
    lines.push('', '_No approved tickets on this sprint._');
  }

  // Existing tasks (replan signal). The planner is told its output
  // REPLACES this list — the harness saves the new array atomically.
  if (existingTasks.length > 0) {
    lines.push('', '## Existing Tasks (will be replaced)');
    for (const task of existingTasks) {
      lines.push('', `### ${task.name}`);
      lines.push(`- id: ${String(task.id)}`);
      if (task.description !== undefined) lines.push(`- description: ${task.description}`);
      if (task.ticketId !== undefined) lines.push(`- ticketId: ${String(task.ticketId)}`);
      lines.push(`- projectPath: ${String(task.projectPath)}`);
      lines.push(`- status: ${task.status}`);
    }
  }

  return lines.join('\n');
}

// ───────────────────────── onboard renderers ─────────────────────────

/**
 * Render the optional existing-AGENTS.md slot. The prompt expects either
 * a fenced block describing the prior body, or an empty string when the
 * onboarding mode is `bootstrap` (no prior file).
 */
export function renderExistingAgentsMd(body: string | undefined): string {
  if (body === undefined) return '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return ['**Existing project context file body:**', '', '```markdown', trimmed, '```'].join('\n');
}
