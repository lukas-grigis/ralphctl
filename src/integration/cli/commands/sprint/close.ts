import { spawnSync } from 'node:child_process';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import {
  closeSprint,
  getSprint,
  listSprints,
  SprintNotFoundError,
  SprintStatusError,
} from '@src/integration/persistence/sprint.ts';
import { areAllTasksDone, listTasks } from '@src/integration/persistence/task.ts';
import { resolveRepoPath } from '@src/integration/persistence/project.ts';
import { selectSprint } from '@src/integration/cli/commands/shared/selectors.ts';
import {
  formatSprintStatus,
  log,
  showError,
  showRandomQuote,
  showSuccess,
  showWarning,
} from '@src/integration/ui/theme/ui.ts';
import { branchExists, getDefaultBranch, isGhAvailable } from '@src/integration/external/git.ts';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';

export async function sprintCloseCommand(args: string[]): Promise<void> {
  let sprintId: string;
  let createPr = false;

  // Parse args
  const positionalArgs: string[] = [];
  for (const arg of args) {
    if (arg === '--create-pr') {
      createPr = true;
    } else {
      positionalArgs.push(arg);
    }
  }

  // If explicit ID provided, use it
  if (positionalArgs[0]) {
    sprintId = positionalArgs[0];
  } else {
    // Check active sprints - show selector if multiple, auto-select if one
    const sprints = await listSprints();
    const activeSprints = sprints.filter((s) => s.status === 'active');

    if (activeSprints.length === 0) {
      showError('No active sprints to close.');
      log.newline();
      return;
    } else if (activeSprints.length === 1 && activeSprints[0]) {
      sprintId = activeSprints[0].id;
    } else {
      const selected = await selectSprint('Select sprint to close:', ['active']);
      if (!selected) return;
      sprintId = selected;
    }
  }

  // Check if all tasks are done
  const allDone = await areAllTasksDone(sprintId);
  if (!allDone) {
    const tasks = await listTasks(sprintId);
    const remaining = tasks.filter((t) => t.status !== 'done');
    log.newline();
    showWarning(`${String(remaining.length)} task(s) are not done:`);
    for (const task of remaining) {
      log.item(`${task.id}: ${task.name} (${task.status})`);
    }
    log.newline();

    const proceed = await getPrompt().confirm({
      message: 'Close sprint anyway?',
      default: false,
    });

    if (!proceed) {
      console.log(muted('\nSprint close cancelled.\n'));
      return;
    }
  }

  const closeR = await wrapAsync(async () => {
    // Load sprint before closing (need branch info for PR creation)
    const sprintBeforeClose = await getSprint(sprintId);
    const sprint = await closeSprint(sprintId);
    return { sprintBeforeClose, sprint };
  }, ensureError);
  if (!closeR.ok) {
    const err = closeR.error;
    if (err instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId}`);
      log.newline();
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
    return;
  }

  const { sprintBeforeClose, sprint } = closeR.value;
  showSuccess('Sprint closed!', [
    ['ID', sprint.id],
    ['Name', sprint.name],
    ['Status', formatSprintStatus(sprint.status)],
  ]);
  showRandomQuote();
  log.newline();

  // Create PRs if requested and sprint had a branch
  if (createPr && sprintBeforeClose.branch) {
    await createPullRequests(sprintId, sprintBeforeClose.branch, sprint.name);
  } else if (createPr && !sprintBeforeClose.branch) {
    log.dim('No sprint branch set — skipping PR creation.');
    log.newline();
  }
}

/**
 * Create pull requests for each repo that has tasks.
 * Best-effort — prints manual command on failure.
 */
async function createPullRequests(sprintId: string, branchName: string, sprintName: string): Promise<void> {
  if (!isGhAvailable()) {
    showWarning('GitHub CLI (gh) not found. Install it to create PRs automatically.');
    log.dim(`  Manual: gh pr create --head ${branchName} --title "Sprint: ${sprintName}"`);
    log.newline();
    return;
  }

  const tasks = await listTasks(sprintId);
  // Resolve unique repo paths via repoId; skip any repo we can't resolve.
  const uniqueRepoIds = [...new Set(tasks.map((t) => t.repoId))];
  const uniquePaths: string[] = [];
  for (const repoId of uniqueRepoIds) {
    const p = await resolveRepoPath(repoId).catch(() => null);
    if (p) uniquePaths.push(p);
  }

  for (const projectPath of uniquePaths) {
    const prR = Result.try(() => {
      assertSafeCwd(projectPath);
      return { branchExists: branchExists(projectPath, branchName) };
    });
    if (!prR.ok) {
      showWarning(`Error creating PR for ${projectPath}: ${prR.error.message}`);
      continue;
    }

    if (!prR.value.branchExists) {
      log.dim(`Branch '${branchName}' not found in ${projectPath} — skipping`);
      continue;
    }

    const baseBranch = getDefaultBranch(projectPath);
    const title = `Sprint: ${sprintName}`;

    log.info(`Creating PR in ${projectPath}...`);

    // Push the branch first
    const pushResult = spawnSync('git', ['push', '-u', 'origin', branchName], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (pushResult.status !== 0) {
      showWarning(`Failed to push branch in ${projectPath}: ${pushResult.stderr.trim()}`);
      log.dim(
        `  Manual: cd ${projectPath} && git push -u origin ${branchName} && gh pr create --base ${baseBranch} --head ${branchName} --title "${title}"`
      );
      continue;
    }

    const result = spawnSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        branchName,
        '--title',
        title,
        '--body',
        `Sprint: ${sprintName}\nID: ${sprintId}`,
      ],
      {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    if (result.status === 0) {
      const prUrl = result.stdout.trim();
      showSuccess(`PR created: ${prUrl}`);
    } else {
      showWarning(`Failed to create PR in ${projectPath}: ${result.stderr.trim()}`);
      log.dim(
        `  Manual: cd ${projectPath} && gh pr create --base ${baseBranch} --head ${branchName} --title "${title}"`
      );
    }
  }
  log.newline();
}
