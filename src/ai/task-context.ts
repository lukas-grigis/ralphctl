import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { muted, warning } from '@src/theme/index.ts';
import { checkTaskPermissions } from '@src/ai/permissions.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import type { Project, Sprint, Task } from '@src/schemas/index.ts';
import { assertSafeCwd } from '@src/utils/paths.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskContext {
  sprint: Sprint;
  task: Task;
  project?: Project;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get recent git history for a project path.
 */
export function getRecentGitHistory(projectPath: string, count = 20): string {
  try {
    assertSafeCwd(projectPath);
    const result = execSync(`git log -${String(count)} --oneline --no-decorate`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return '(Unable to retrieve git history)';
  }
}

/**
 * Detect verification script based on project files.
 */
export function detectVerifyScript(projectPath: string): string | null {
  // Node.js/npm projects
  if (existsSync(join(projectPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const commands: string[] = [];

      if (scripts['lint']) commands.push('npm run lint');
      if (scripts['typecheck']) commands.push('npm run typecheck');
      if (scripts['test']) commands.push('npm run test');

      if (commands.length > 0) {
        return commands.join(' && ');
      }
      return null;
    } catch {
      return null;
    }
  }

  // Python projects
  if (existsSync(join(projectPath, 'pyproject.toml')) || existsSync(join(projectPath, 'setup.py'))) {
    return 'pytest';
  }

  // Go projects
  if (existsSync(join(projectPath, 'go.mod'))) {
    return 'go test ./...';
  }

  // Rust projects
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    return 'cargo test';
  }

  // Java/Gradle projects
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    return './gradlew check';
  }

  // Java/Maven projects
  if (existsSync(join(projectPath, 'pom.xml'))) {
    return 'mvn clean install';
  }

  // Makefile projects
  if (existsSync(join(projectPath, 'Makefile'))) {
    return 'make check || make test';
  }

  return null;
}

/**
 * Get effective verify script for a project repository.
 * Finds the matching repository by path and returns its verify script,
 * or falls back to auto-detection.
 */
export function getEffectiveVerifyScript(project: Project | undefined, projectPath: string): string | null {
  if (project) {
    // Find the repository that matches the project path
    const repo = project.repositories.find((r) => r.path === projectPath);
    if (repo?.verifyScript) {
      return repo.verifyScript;
    }
  }
  return detectVerifyScript(projectPath);
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
 * - HIGH ATTENTION (start): Task directive, steps, verification
 * - REFERENCE (middle): Prior learnings, ticket requirements, git history
 * - HIGH ATTENTION (end): Instructions (appended by writeTaskContextFile)
 */
export function buildFullTaskContext(
  ctx: TaskContext,
  progressSummary: string | null,
  gitHistory: string,
  verifyScript: string | null
): string {
  const lines: string[] = [];

  // ═══ HIGH ATTENTION ZONE (beginning) ═══

  lines.push(formatTask(ctx));

  // Verification command — near the top so it's easy to find
  lines.push('');
  lines.push('## Verification Command');
  lines.push('');
  if (verifyScript) {
    lines.push('```bash');
    lines.push(verifyScript);
    lines.push('```');
  } else {
    lines.push('Read CLAUDE.md in the project root to find verification commands.');
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

  try {
    return await getProject(ticket.projectName);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return undefined;
    }
    throw err;
  }
}

// ============================================================================
// PERMISSION CHECKS
// ============================================================================

/**
 * Run pre-flight permission checks and display any warnings.
 */
export function runPreFlightCheck(ctx: TaskContext, noCommit: boolean): void {
  const verifyScript = getEffectiveVerifyScript(ctx.project, ctx.task.projectPath);

  // Find the repository that matches the project path for setup script
  const repo = ctx.project?.repositories.find((r) => r.path === ctx.task.projectPath);
  const setupScript = repo?.setupScript;

  const warnings = checkTaskPermissions(ctx.task.projectPath, {
    verifyScript,
    setupScript,
    needsCommit: !noCommit,
  });

  if (warnings.length > 0) {
    console.log(warning('\n  Permission warnings:'));
    for (const w of warnings) {
      console.log(muted(`    - ${w.message}`));
    }
    console.log(muted('  Consider adjusting tool permissions for your AI provider\n'));
  }
}
