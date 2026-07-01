import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import { pathIsDirectory, pathIsWritable } from '@src/integration/io/fs.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import {
  type DoctorCtx,
  type DoctorInput,
  type DoctorReport,
  MIN_NODE_MAJOR,
  type ProbeGroup,
  type ProbeResult,
} from '@src/application/flows/doctor/ctx.ts';
import type { DoctorDeps } from '@src/application/flows/doctor/deps.ts';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  'claude-code': 'Claude Code',
  'github-copilot': 'GitHub Copilot',
  'openai-codex': 'OpenAI Codex',
};

const probePath = async (id: string, label: string, path: AbsolutePath, group: ProbeGroup): Promise<ProbeResult> => {
  const result = await pathIsDirectory(String(path));
  if (!result.ok) return { id, label, status: 'fail', detail: result.error.message, group };
  return { id, label, status: result.value ? 'pass' : 'fail', detail: String(path), group };
};

const probeWritable = async (id: string, label: string, path: AbsolutePath): Promise<ProbeResult> => {
  const result = await pathIsWritable(String(path));
  if (!result.ok) {
    return {
      id,
      label,
      status: 'fail',
      detail: result.error.message,
      group: 'storage',
      hint: `check filesystem permissions on ${String(path)}`,
    };
  }
  if (result.value) return { id, label, status: 'pass', detail: String(path), group: 'storage' };
  return {
    id,
    label,
    status: 'fail',
    detail: `${String(path)} — not writable by the current user`,
    group: 'storage',
    hint: `chmod / re-own ${String(path)} so ralphctl can persist sprints + settings`,
  };
};

/**
 * Parse the `vX.Y.Z` prefix off `process.version` and compare the major against
 * `MIN_NODE_MAJOR`. Older majors fail (the implement loop expects modern Node APIs); future
 * majors pass with an informational detail.
 */
const probeNodeVersion = (nodeVersion: string): ProbeResult => {
  const NODE_VERSION_ID = 'node-version';
  const NODE_VERSION_LABEL = 'Node version';
  const match = /^v(\d+)\./.exec(nodeVersion);
  if (match === null || match[1] === undefined) {
    return {
      id: NODE_VERSION_ID,
      label: NODE_VERSION_LABEL,
      status: 'warn',
      detail: `could not parse '${nodeVersion}'`,
      group: 'runtime',
    };
  }
  const major = Number.parseInt(match[1], 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      id: NODE_VERSION_ID,
      label: NODE_VERSION_LABEL,
      status: 'fail',
      detail: `${nodeVersion} — ralphctl requires Node ≥ ${String(MIN_NODE_MAJOR)} (mise.toml)`,
      group: 'runtime',
      hint: `run \`mise install\` or upgrade Node to v${String(MIN_NODE_MAJOR)}+`,
    };
  }
  return {
    id: NODE_VERSION_ID,
    label: NODE_VERSION_LABEL,
    status: 'pass',
    detail: `${nodeVersion} (mise.toml expects ≥ v${String(MIN_NODE_MAJOR)})`,
    group: 'runtime',
  };
};

const probeBinary = async (
  id: string,
  label: string,
  binary: string,
  group: ProbeGroup,
  commandExists: (name: string) => Promise<boolean>,
  hint: string
): Promise<ProbeResult> => {
  const installed = await commandExists(binary);
  return {
    id,
    label,
    status: installed ? 'pass' : 'fail',
    detail: installed ? `${binary} found on PATH` : `${binary} not found on PATH`,
    group,
    ...(installed ? {} : { hint }),
  };
};

/**
 * `git config --get <key>` returns the value on stdout with a trailing newline, exit 0; exits
 * non-zero with empty output when the key is not set. Treats unset values as `warn` (not
 * `fail`) — ralphctl can still operate without identity configured, but commits authored by
 * the implement chain would lack proper attribution.
 */
const probeGitConfig = async (
  id: string,
  label: string,
  key: string,
  runCommand: RunCommand,
  hint: string
): Promise<ProbeResult> => {
  const r = await runCommand('git', ['config', '--get', key]);
  const value = r.stdout.trim();
  if (r.ok && value.length > 0) {
    return { id, label, status: 'pass', detail: value, group: 'vcs' };
  }
  return { id, label, status: 'warn', detail: `${key} not set`, hint, group: 'vcs' };
};

const probeCliAuth = async (
  id: string,
  label: string,
  binary: string,
  args: readonly string[],
  hint: string,
  runCommand: RunCommand,
  group: ProbeGroup = 'vcs'
): Promise<ProbeResult> => {
  const r = await runCommand(binary, args);
  if (r.ok) {
    return { id, label, status: 'pass', detail: 'authenticated', group };
  }
  const detail =
    r.stderr
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? 'not authenticated';
  return { id, label, status: 'warn', detail, hint, group };
};

/** Probe storage paths for readability and writability. */
const probeStorageGroup = async (input: DoctorInput): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];
  probes.push(await probePath('data-root', 'Data root readable', input.dataRoot, 'storage'));
  probes.push(await probePath('config-root', 'Config root readable', input.configRoot, 'storage'));
  probes.push(await probeWritable('data-root-writable', 'Data root writable', input.dataRoot));
  probes.push(await probeWritable('config-root-writable', 'Config root writable', input.configRoot));
  return probes;
};

/** Probe settings file persistence. */
const probeSettingsGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];
  const SETTINGS_PERSISTED_ID = 'settings-persisted';
  const SETTINGS_PRESENT_LABEL = 'Settings file present';
  const settingsPath = deps.settingsRepo.path;
  const settingsExists = await deps.settingsRepo.exists();
  if (!settingsExists.ok) {
    probes.push({
      id: SETTINGS_PERSISTED_ID,
      label: SETTINGS_PRESENT_LABEL,
      status: 'fail',
      detail: `${settingsPath} — ${settingsExists.error.message}`,
      group: 'settings',
    });
  } else if (settingsExists.value) {
    probes.push({
      id: SETTINGS_PERSISTED_ID,
      label: SETTINGS_PRESENT_LABEL,
      status: 'pass',
      detail: settingsPath,
      group: 'settings',
    });
  } else {
    probes.push({
      id: SETTINGS_PERSISTED_ID,
      label: SETTINGS_PRESENT_LABEL,
      status: 'warn',
      detail: `${settingsPath} — using built-in defaults (first run)`,
      hint: 'open the welcome flow to pick a provider and persist your settings',
      group: 'settings',
    });
  }
  return probes;
};

/** Probe VCS tooling: git, GitHub CLI, GitLab CLI, and their authentication. */
const probeVcsToolingGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const gitInstalled = await deps.commandExists('git');
  probes.push({
    id: 'git-installed',
    label: 'Git installed',
    status: gitInstalled ? 'pass' : 'fail',
    detail: gitInstalled ? 'git found on PATH' : 'git not found on PATH',
    group: 'vcs',
    ...(gitInstalled ? {} : { hint: 'install git — required for implement / review flows' }),
  });
  if (gitInstalled) {
    probes.push(
      await probeGitConfig(
        'git-user-name',
        'Git user.name',
        'user.name',
        deps.runCommand,
        'run `git config --global user.name "<your name>"` so commits are attributed correctly'
      )
    );
    probes.push(
      await probeGitConfig(
        'git-user-email',
        'Git user.email',
        'user.email',
        deps.runCommand,
        'run `git config --global user.email "<you@example.com>"` so commits are attributed correctly'
      )
    );
  }

  const ghInstalled = await deps.commandExists('gh');
  probes.push({
    id: 'gh-installed',
    label: 'GitHub CLI (`gh`) installed',
    status: ghInstalled ? 'pass' : 'warn',
    detail: ghInstalled ? 'gh found on PATH' : 'gh not found on PATH',
    group: 'vcs',
    ...(ghInstalled ? {} : { hint: 'install gh from https://cli.github.com if you target GitHub' }),
  });
  if (ghInstalled) {
    probes.push(
      await probeCliAuth(
        'gh-auth',
        'GitHub CLI authenticated',
        'gh',
        ['auth', 'status'],
        'run `gh auth login` to sign in',
        deps.runCommand
      )
    );
  }

  const glabInstalled = await deps.commandExists('glab');
  probes.push({
    id: 'glab-installed',
    label: 'GitLab CLI (`glab`) installed',
    status: glabInstalled ? 'pass' : 'warn',
    detail: glabInstalled ? 'glab found on PATH' : 'glab not found on PATH',
    group: 'vcs',
    ...(glabInstalled ? {} : { hint: 'install glab from https://gitlab.com/gitlab-org/cli if you target GitLab' }),
  });
  if (glabInstalled) {
    probes.push(
      await probeCliAuth(
        'glab-auth',
        'GitLab CLI authenticated',
        'glab',
        ['auth', 'status'],
        'run `glab auth login` to sign in',
        deps.runCommand
      )
    );
  }

  return probes;
};

/** Probe AI provider CLIs and their authentication. */
const probeAiProvidersGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const settings = await deps.settingsRepo.load();
  // Per-flow rows can each pick a provider; surface every provider that appears on any row
  // as "configured" so the doctor flags binaries the user actually relies on.
  const configuredProviders: ReadonlySet<AiProvider> = settings.ok
    ? new Set<AiProvider>([
        settings.value.ai.refine.provider,
        settings.value.ai.plan.provider,
        settings.value.ai.implement.generator.provider,
        settings.value.ai.implement.evaluator.provider,
        settings.value.ai.readiness.provider,
        settings.value.ai.ideate.provider,
      ])
    : new Set<AiProvider>();

  let codexInstalled = false;
  for (const provider of Object.keys(PROVIDER_BINARY) as readonly AiProvider[]) {
    const binary = PROVIDER_BINARY[provider];
    const isConfigured = configuredProviders.has(provider);
    const probe = await probeBinary(
      `ai-${provider}`,
      `${PROVIDER_LABEL[provider]}${isConfigured ? ' (configured)' : ''}`,
      binary,
      'ai',
      deps.commandExists,
      `install the '${binary}' CLI and ensure it is on your PATH`
    );
    if (provider === 'openai-codex') codexInstalled = probe.status === 'pass';
    if (probe.status === 'fail') {
      probes.push({ ...probe, status: 'warn' });
    } else {
      probes.push(probe);
    }
  }

  if (configuredProviders.has('openai-codex') && codexInstalled) {
    probes.push(
      await probeCliAuth(
        'codex-auth',
        'OpenAI Codex CLI authenticated',
        'codex',
        ['login', 'status'],
        'run `codex login` to sign in',
        deps.runCommand,
        'ai'
      )
    );
  }

  return probes;
};

/** Probe repository lists and data integrity. */
const probeRepositoriesAndIntegrityGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const projects = await deps.projectRepo.list();
  probes.push({
    id: 'projects-list',
    label: 'Project repository responds',
    status: projects.ok ? 'pass' : 'fail',
    detail: projects.ok ? `${String(projects.value.length)} project(s)` : projects.error.message,
    group: 'repositories',
  });

  const sprints = await deps.sprintRepo.list();
  probes.push({
    id: 'sprints-list',
    label: 'Sprint repository responds',
    status: sprints.ok ? 'pass' : 'fail',
    detail: sprints.ok ? `${String(sprints.value.length)} sprint(s)` : sprints.error.message,
    group: 'repositories',
  });

  if (projects.ok && projects.value.length > 0) {
    probes.push(...(await probeProjectRepoPaths(projects.value)));
    probes.push(...(await probeProjectDefaultBranches(projects.value, deps.runCommand)));
  }

  if (sprints.ok && sprints.value.length > 0) {
    probes.push(await probeSprintExecutionPairing(sprints.value, deps.sprintExecutionRepo));
  }

  return probes;
};

/**
 * Run the standard sanity probes and report each one's outcome. Always resolves to ok — a
 * failed probe is data, not an error.
 *
 * Probe order is the rendering order. Probes are grouped (see `ProbeGroup`) so the doctor
 * view can stamp section headers without per-probe routing logic.
 */
export const createDoctorFlow = (deps: DoctorDeps): Element<DoctorCtx> =>
  leaf<DoctorCtx, DoctorInput, DoctorReport>('doctor', {
    useCase: {
      async execute(input) {
        const probes: ProbeResult[] = [];

        probes.push(...(await probeStorageGroup(input)));
        probes.push(probeNodeVersion(deps.nodeVersion));
        probes.push(...(await probeSettingsGroup(deps)));
        probes.push(...(await probeVcsToolingGroup(deps)));
        probes.push(...(await probeAiProvidersGroup(deps)));
        probes.push(...(await probeRepositoriesAndIntegrityGroup(deps)));

        const hasFailures = probes.some((p) => p.status === 'fail');
        const allPassed = probes.every((p) => p.status === 'pass');
        return Result.ok({ probes, allPassed, hasFailures });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });

const probeProjectRepoPaths = async (projects: readonly Project[]): Promise<readonly ProbeResult[]> => {
  const out: ProbeResult[] = [];
  for (const project of projects) {
    const missing: string[] = [];
    for (const repo of project.repositories) {
      const r = await pathIsDirectory(String(repo.path));
      if (!r.ok || !r.value) missing.push(`${repo.slug} → ${String(repo.path)}`);
    }
    if (missing.length === 0) {
      out.push({
        id: `project-paths-${project.slug}`,
        label: `Project '${project.slug}': repo paths resolve`,
        status: 'pass',
        detail: `${String(project.repositories.length)} repo(s) present`,
        group: 'integrity',
      });
    } else {
      out.push({
        id: `project-paths-${project.slug}`,
        label: `Project '${project.slug}': repo paths resolve`,
        status: 'fail',
        detail: `missing: ${missing.join('; ')}`,
        hint: 'remove the project, re-clone the repo, or update its path via the TUI',
        group: 'integrity',
      });
    }
  }
  return out;
};

const probeProjectDefaultBranches = async (
  projects: readonly Project[],
  runCommand: RunCommand
): Promise<readonly ProbeResult[]> => {
  const out: ProbeResult[] = [];
  for (const project of projects) {
    for (const repo of project.repositories) {
      const result = await runCommand('git', ['-C', String(repo.path), 'rev-parse', '--abbrev-ref', 'origin/HEAD']);
      const branch = result.stdout.trim();
      if (result.ok && branch.length > 0) {
        out.push({
          id: `default-branch-${project.slug}-${repo.slug}`,
          label: `${project.slug}/${repo.slug}: default branch`,
          status: 'pass',
          detail: branch,
          group: 'integrity',
        });
      } else {
        out.push({
          id: `default-branch-${project.slug}-${repo.slug}`,
          label: `${project.slug}/${repo.slug}: default branch`,
          status: 'warn',
          detail: 'no resolvable origin/HEAD',
          hint: `run \`git -C ${String(repo.path)} remote set-head origin --auto\` to discover it`,
          group: 'integrity',
        });
      }
    }
  }
  return out;
};

/**
 * Surface sprints whose execution record is missing AND whose work-in-flight is fully
 * recoverable. `active`, `review`, and `done` orphans are NOT reported — those would surface
 * as `NotFoundError` at run time. Always reports as `warn` (never `fail`).
 */
const probeSprintExecutionPairing = async (
  sprints: readonly Sprint[],
  sprintExecutionRepo: SprintExecutionRepository
): Promise<ProbeResult> => {
  const recoverable: string[] = [];
  for (const sprint of sprints) {
    const r = await sprintExecutionRepo.findById(sprint.id);
    if (r.ok) continue;
    if (sprint.status === 'planned' || (sprint.status === 'draft' && sprint.tickets.length > 0)) {
      recoverable.push(sprint.slug);
    }
  }
  if (recoverable.length === 0) {
    return {
      id: 'sprint-execution-pairing',
      label: 'Pending sprints have a paired execution record',
      status: 'pass',
      detail: `${String(sprints.length)} sprint(s) verified`,
      group: 'integrity',
    };
  }
  return {
    id: 'sprint-execution-pairing',
    label: 'Pending sprints have a paired execution record',
    status: 'warn',
    detail: `missing execution for pending sprint(s): ${recoverable.join(', ')}`,
    hint: 'recreate the execution by re-running create-sprint, or remove the sprint if it is no longer needed',
    group: 'integrity',
  };
};
