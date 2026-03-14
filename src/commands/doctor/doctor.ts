import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { getConfig } from '@src/store/config.ts';
import { listProjects } from '@src/store/project.ts';
import { SprintSchema } from '@src/schemas/index.ts';
import { getDataDir, getSprintFilePath } from '@src/utils/paths.ts';
import { validateProjectPath } from '@src/utils/paths.ts';
import { fileExists, readValidatedJson } from '@src/utils/storage.ts';
import { colors, getQuoteForContext } from '@src/theme/index.ts';
import { icons, log, printHeader } from '@src/theme/ui.ts';
import { EXIT_ERROR } from '@src/utils/exit-codes.ts';
import { isGlabAvailable } from '@src/utils/git.ts';

const REQUIRED_NODE_MAJOR = 24;

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail?: string;
}

/**
 * Check Node.js version >= 24.0.0
 */
export function checkNodeVersion(): CheckResult {
  const version = process.version; // e.g., "v24.1.0"
  const match = /^v(\d+)/.exec(version);
  const major = match ? Number(match[1]) : 0;

  if (major >= REQUIRED_NODE_MAJOR) {
    return { name: 'Node.js version', status: 'pass', detail: version };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    detail: `${version} (requires >= ${String(REQUIRED_NODE_MAJOR)}.0.0)`,
  };
}

/**
 * Check git is installed
 */
export function checkGitInstalled(): CheckResult {
  const result = spawnSync('git', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    const version = result.stdout.trim();
    return { name: 'Git installed', status: 'pass', detail: version };
  }
  return { name: 'Git installed', status: 'fail', detail: 'git not found in PATH' };
}

/**
 * Check git identity (user.name and user.email)
 */
export function checkGitIdentity(): CheckResult {
  const nameResult = spawnSync('git', ['config', 'user.name'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const emailResult = spawnSync('git', ['config', 'user.email'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const name = nameResult.status === 0 ? nameResult.stdout.trim() : '';
  const email = emailResult.status === 0 ? emailResult.stdout.trim() : '';

  if (name && email) {
    return { name: 'Git identity', status: 'pass', detail: `${name} <${email}>` };
  }

  const missing: string[] = [];
  if (!name) missing.push('user.name');
  if (!email) missing.push('user.email');
  return { name: 'Git identity', status: 'warn', detail: `missing: ${missing.join(', ')}` };
}

/**
 * Check AI provider binary is on PATH
 */
export async function checkAiProvider(): Promise<CheckResult> {
  const config = await getConfig();
  const provider = config.aiProvider;

  if (!provider) {
    return { name: 'AI provider binary', status: 'skip', detail: 'not configured' };
  }

  const binary = provider === 'claude' ? 'claude' : 'copilot';
  const result = spawnSync('which', [binary], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    return { name: 'AI provider binary', status: 'pass', detail: `${binary} found` };
  }
  return {
    name: 'AI provider binary',
    status: 'fail',
    detail: `${binary} not found in PATH (provider: ${provider})`,
  };
}

/**
 * Check glab CLI availability (informational — for GitLab issue enrichment)
 */
export function checkGlabInstalled(): CheckResult {
  if (isGlabAvailable()) {
    return { name: 'GitLab CLI (glab)', status: 'pass', detail: 'installed' };
  }
  return {
    name: 'GitLab CLI (glab)',
    status: 'skip',
    detail: 'not installed (optional — needed for GitLab issue enrichment)',
  };
}

/**
 * Check data directory exists and is writable
 */
export async function checkDataDirectory(): Promise<CheckResult> {
  const dataDir = getDataDir();

  const accessR = await wrapAsync(() => access(dataDir, constants.R_OK | constants.W_OK), ensureError);
  if (accessR.ok) {
    return { name: 'Data directory', status: 'pass', detail: dataDir };
  }
  return { name: 'Data directory', status: 'fail', detail: `${dataDir} not accessible or writable` };
}

/**
 * Check project paths exist and are git repos
 */
export async function checkProjectPaths(): Promise<CheckResult> {
  const projects = await listProjects();

  if (projects.length === 0) {
    return { name: 'Project paths', status: 'skip', detail: 'no projects registered' };
  }

  const issues: string[] = [];

  for (const project of projects) {
    for (const repo of project.repositories) {
      const validation = await validateProjectPath(repo.path);
      if (!validation.ok) {
        issues.push(`${project.name}/${repo.name}: ${validation.error.message}`);
        continue;
      }

      const gitDir = join(repo.path, '.git');
      if (!(await fileExists(gitDir))) {
        issues.push(`${project.name}/${repo.name}: not a git repository`);
      }
    }
  }

  if (issues.length === 0) {
    const repoCount = projects.reduce((sum, p) => sum + p.repositories.length, 0);
    return {
      name: 'Project paths',
      status: 'pass',
      detail: `${String(repoCount)} repo${repoCount !== 1 ? 's' : ''} verified`,
    };
  }

  return { name: 'Project paths', status: 'fail', detail: issues.join('; ') };
}

/**
 * Check current sprint validity
 */
export async function checkCurrentSprint(): Promise<CheckResult> {
  const config = await getConfig();
  const sprintId = config.currentSprint;

  if (!sprintId) {
    return { name: 'Current sprint', status: 'skip', detail: 'no current sprint set' };
  }

  const sprintPath = getSprintFilePath(sprintId);
  if (!(await fileExists(sprintPath))) {
    return { name: 'Current sprint', status: 'fail', detail: `sprint file missing: ${sprintId}` };
  }

  const result = await readValidatedJson(sprintPath, SprintSchema);
  if (!result.ok) {
    return { name: 'Current sprint', status: 'fail', detail: `invalid sprint data: ${result.error.message}` };
  }
  return { name: 'Current sprint', status: 'pass', detail: `${result.value.name} (${result.value.status})` };
}

/**
 * Run all doctor checks and print results.
 */
export async function doctorCommand(): Promise<void> {
  printHeader('System Health Check', icons.info);

  const results: CheckResult[] = [];

  // Synchronous checks
  results.push(checkNodeVersion());
  results.push(checkGitInstalled());
  results.push(checkGitIdentity());
  results.push(checkGlabInstalled());

  // Async checks (independent — run in parallel)
  const asyncResults = await Promise.all([
    checkAiProvider(),
    checkDataDirectory(),
    checkProjectPaths(),
    checkCurrentSprint(),
  ]);
  results.push(...asyncResults);

  // Print results
  for (const result of results) {
    if (result.status === 'pass') {
      log.success(`${result.name}${result.detail ? colors.muted(` — ${result.detail}`) : ''}`);
    } else if (result.status === 'warn') {
      log.warn(`${result.name}${result.detail ? colors.muted(` — ${result.detail}`) : ''}`);
    } else if (result.status === 'fail') {
      log.error(result.name);
      if (result.detail) {
        log.dim(`    ${result.detail}`);
      }
    } else {
      log.raw(
        `${icons.bullet}  ${colors.muted(result.name)} ${colors.muted('—')} ${colors.muted(result.detail ?? 'skipped')}`
      );
    }
  }

  // Summary
  log.newline();
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const total = results.filter((r) => r.status !== 'skip').length;

  if (failed === 0 && warned === 0) {
    log.success(`All checks passed (${String(passed)}/${String(total)})`);
    log.newline();
    const quote = getQuoteForContext('success');
    log.dim(`"${quote}"`);
  } else if (failed === 0) {
    log.success(
      `${String(passed)}/${String(total)} checks passed, ${String(warned)} warning${warned !== 1 ? 's' : ''}`
    );
    log.newline();
    const quote = getQuoteForContext('success');
    log.dim(`"${quote}"`);
  } else {
    log.error(`${String(passed)}/${String(total)} checks passed, ${String(failed)} failed`);
    log.newline();
    const quote = getQuoteForContext('error');
    log.dim(`"${quote}"`);
    process.exitCode = EXIT_ERROR;
  }

  log.newline();
}
