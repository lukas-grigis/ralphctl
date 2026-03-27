import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from 'typescript-result';
import { muted, warning } from '@src/theme/index.ts';
import { checkTaskPermissions } from '@src/ai/permissions.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import type { AiProvider, Project, Sprint, Task } from '@src/schemas/index.ts';
import { assertSafeCwd } from '@src/utils/paths.ts';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskContext {
  sprint: Sprint;
  task: Task;
  project?: Project;
}

/** Outcome of a check script for a single project path. */
export type CheckStatus = { ran: true; script: string } | { ran: false; reason: 'no-script' };

/** Map from projectPath → CheckStatus, populated by runCheckScripts. */
export type CheckResults = Map<string, CheckStatus>;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get recent git history for a project path.
 */
export function getRecentGitHistory(projectPath: string, count = 20): string {
  const r = Result.try(() => {
    assertSafeCwd(projectPath);
    const result = execSync(`git log -${String(count)} --oneline --no-decorate`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  });
  return r.ok ? r.value : '(Unable to retrieve git history)';
}

/**
 * Get check script from explicit repository config only.
 * Returns null if no check script is configured — no runtime auto-detection.
 * Heuristic detection is used only as suggestions during `project add`.
 */
export function getEffectiveCheckScript(project: Project | undefined, projectPath: string): string | null {
  if (project) {
    const repo = project.repositories.find((r) => r.path === projectPath);
    if (repo?.checkScript) {
      return repo.checkScript;
    }
  }
  return null;
}

export function formatTask(ctx: TaskContext): string {
  const lines: string[] = [];

  // ═══ TASK DIRECTIVE (highest attention) ═══
  lines.push('## Task Directive');
  lines.push('');
  lines.push(`**Task:** ${ctx.task.name}`);
  lines.push(`**ID:** ${ctx.task.id}`);
  lines.push(`**Project:** ${ctx.task.projectPath}`);
  lines.push('');
  lines.push('**ONE TASK ONLY.** Complete THIS task and nothing else. Do not continue to other tasks.');

  if (ctx.task.description) {
    lines.push('');
    lines.push(ctx.task.description);
  }

  // ═══ TASK STEPS (primary content — positioned first for maximum attention) ═══
  if (ctx.task.steps.length > 0) {
    lines.push('');
    lines.push('## Implementation Steps');
    lines.push('');
    lines.push('Follow these steps precisely and in order:');
    lines.push('');
    ctx.task.steps.forEach((step, i) => {
      lines.push(`${String(i + 1)}. ${step}`);
    });
  }

  return lines.join('\n');
}

/**
 * Build the full task context with primacy/recency optimization.
 *
 * Layout applies the primacy/recency effect:
 * - HIGH ATTENTION (start): Task directive, steps, check script
 * - REFERENCE (middle): Prior learnings, ticket requirements, git history
 * - HIGH ATTENTION (end): Instructions (appended by writeTaskContextFile)
 */
export function buildFullTaskContext(
  ctx: TaskContext,
  progressSummary: string | null,
  gitHistory: string,
  checkScript: string | null,
  checkStatus?: CheckStatus
): string {
  const lines: string[] = [];

  // ═══ HIGH ATTENTION ZONE (beginning) ═══

  lines.push(formatTask(ctx));

  // Branch awareness — tell the agent which branch it's on
  if (ctx.sprint.branch) {
    lines.push('');
    lines.push('## Branch');
    lines.push('');
    lines.push(
      `You are working on branch \`${ctx.sprint.branch}\`. All commits go to this branch. Do not switch branches.`
    );
  }

  // Check script — near the top so it's easy to find
  lines.push('');
  lines.push('## Check Script');
  lines.push('');
  if (checkScript) {
    lines.push('The harness runs this command at sprint start and after every task as a post-task gate:');
    lines.push('');
    lines.push('```bash');
    lines.push(checkScript);
    lines.push('```');
    lines.push('');
    lines.push('Your task is NOT marked done unless this command passes after completion.');
  } else {
    lines.push('No check script is configured. Check the project root for instruction files');
    lines.push('(CLAUDE.md, .github/copilot-instructions.md, README) to find verification commands.');
  }

  // Check status awareness — tell the agent what happened during stage zero
  if (checkStatus) {
    lines.push('');
    lines.push('## Environment Status');
    lines.push('');
    if (checkStatus.ran) {
      lines.push('The check script ran successfully at sprint start. Dependencies are current.');
      lines.push('Do not re-run the install portion unless you encounter dependency errors.');
    } else {
      lines.push(
        'No check script is configured for this repository. ' +
          'Check project instruction files (CLAUDE.md, .github/copilot-instructions.md, README) ' +
          'or configuration files (package.json, pyproject.toml, etc.) ' +
          'to discover build, test, and lint commands.'
      );
    }
  }

  // ═══ REFERENCE ZONE (middle — lower attention is OK) ═══

  lines.push('');
  lines.push('---');
  lines.push('');

  // Prior task learnings (summarized, not raw progress dump)
  if (progressSummary) {
    lines.push('## Prior Task Learnings');
    lines.push('');
    lines.push('_Reference — consult when relevant to your implementation._');
    lines.push('');
    lines.push(progressSummary);
    lines.push('');
  }

  // Ticket requirements (reference only, explicitly deprioritized)
  if (ctx.task.ticketId) {
    const ticket = ctx.sprint.tickets.find((t) => t.id === ctx.task.ticketId);
    if (ticket?.requirements) {
      lines.push('## Ticket Requirements');
      lines.push('');
      lines.push(
        '_Reference — these describe the full ticket scope. This task implements a specific part. ' +
          'Use to validate your work and understand constraints, but follow the Implementation Steps above. ' +
          'Do not expand scope beyond declared steps._'
      );
      lines.push('');
      lines.push(ticket.requirements);
      lines.push('');
    }
  }

  // Git history — awareness of recent changes
  lines.push('## Git History (recent commits)');
  lines.push('');
  lines.push('```');
  lines.push(gitHistory);
  lines.push('```');

  // ═══ HIGH ATTENTION ZONE (end) — Instructions appended by writeTaskContextFile ═══

  return lines.join('\n');
}

export function getContextFileName(sprintId: string, taskId: string): string {
  return `.ralphctl-sprint-${sprintId}-task-${taskId}-context.md`;
}

export async function writeTaskContextFile(
  projectPath: string,
  taskContent: string,
  instructions: string,
  sprintId: string,
  taskId: string
): Promise<string> {
  const contextFile = join(projectPath, getContextFileName(sprintId, taskId));
  const warning = `<!-- TEMPORARY FILE - DO NOT COMMIT -->
<!-- This file is auto-generated by ralphctl for task execution context -->
<!-- It will be automatically cleaned up after task completion -->

`;
  const fullContent = `${warning}${taskContent}\n\n---\n\n## Instructions\n\n${instructions}`;
  await writeFile(contextFile, fullContent, { encoding: 'utf-8', mode: 0o600 });
  return contextFile;
}

/**
 * Try to get the project for a task (via ticket reference).
 */
export async function getProjectForTask(task: Task, sprint: Sprint): Promise<Project | undefined> {
  if (!task.ticketId) return undefined;

  const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
  if (!ticket) return undefined;

  const r = await wrapAsync(async () => getProject(ticket.projectName), ensureError);
  if (r.ok) return r.value;
  if (r.error instanceof ProjectNotFoundError) return undefined;
  throw r.error;
}

// ============================================================================
// PERMISSION CHECKS
// ============================================================================

/**
 * Run permission checks and display any warnings.
 *
 * For Claude: warns about operations that may need approval in settings files.
 * For Copilot: no-op — all tools are granted via --allow-all-tools.
 */
export function runPermissionCheck(ctx: TaskContext, noCommit: boolean, provider?: AiProvider): void {
  const checkScript = getEffectiveCheckScript(ctx.project, ctx.task.projectPath);

  const warnings = checkTaskPermissions(ctx.task.projectPath, {
    checkScript,
    needsCommit: !noCommit,
    provider,
  });

  if (warnings.length > 0) {
    console.log(warning('\n  Permission warnings:'));
    for (const w of warnings) {
      console.log(muted(`    - ${w.message}`));
    }
    console.log(muted('  Consider adjusting tool permissions for your AI provider\n'));
  }
}
