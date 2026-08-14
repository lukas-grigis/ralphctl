import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import { pathIsDirectory, pathIsWritable } from '@src/integration/io/fs.ts';

import {
  type DoctorInput,
  MIN_NODE_MAJOR,
  type ProbeGroup,
  type ProbeResult,
} from '@src/application/flows/doctor/ctx.ts';
import type { DoctorDeps } from '@src/application/flows/doctor/deps.ts';
import { mkProbe, PROVIDER_LABEL } from '@src/application/flows/doctor/probe-helpers.ts';
import { probeProviderAuth } from '@src/application/flows/doctor/provider-auth.ts';

const probePath = async (id: string, label: string, path: AbsolutePath, group: ProbeGroup): Promise<ProbeResult> => {
  const result = await pathIsDirectory(String(path));
  if (!result.ok) return mkProbe(id, label, 'fail', result.error.message, group);
  return mkProbe(id, label, result.value ? 'pass' : 'fail', String(path), group);
};

const probeWritable = async (id: string, label: string, path: AbsolutePath): Promise<ProbeResult> => {
  const result = await pathIsWritable(String(path));
  if (!result.ok) {
    return mkProbe(
      id,
      label,
      'fail',
      result.error.message,
      'storage',
      `check filesystem permissions on ${String(path)}`
    );
  }
  if (result.value) return mkProbe(id, label, 'pass', String(path), 'storage');
  const hint = `chmod / re-own ${String(path)} so ralphctl can persist sprints + settings`;
  return mkProbe(id, label, 'fail', `${String(path)} — not writable by the current user`, 'storage', hint);
};

/**
 * Parse the `vX.Y.Z` prefix off `process.version` and compare the major against
 * `MIN_NODE_MAJOR`. Older majors fail (the implement loop expects modern Node APIs); future
 * majors pass with an informational detail.
 */
export const probeNodeVersion = (nodeVersion: string): ProbeResult => {
  const NODE_VERSION_ID = 'node-version';
  const NODE_VERSION_LABEL = 'Node version';
  const match = /^v(\d+)\./.exec(nodeVersion);
  if (match === null || match[1] === undefined) {
    return mkProbe(NODE_VERSION_ID, NODE_VERSION_LABEL, 'warn', `could not parse '${nodeVersion}'`, 'runtime');
  }
  const major = Number.parseInt(match[1], 10);
  if (major < MIN_NODE_MAJOR) {
    return mkProbe(
      NODE_VERSION_ID,
      NODE_VERSION_LABEL,
      'fail',
      `${nodeVersion} — ralphctl requires Node ≥ ${String(MIN_NODE_MAJOR)} (mise.toml)`,
      'runtime',
      `run \`mise install\` or upgrade Node to v${String(MIN_NODE_MAJOR)}+`
    );
  }
  return mkProbe(
    NODE_VERSION_ID,
    NODE_VERSION_LABEL,
    'pass',
    `${nodeVersion} (mise.toml expects ≥ v${String(MIN_NODE_MAJOR)})`,
    'runtime'
  );
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
  const detail = installed ? `${binary} found on PATH` : `${binary} not found on PATH`;
  return mkProbe(id, label, installed ? 'pass' : 'fail', detail, group, installed ? undefined : hint);
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
  if (r.ok && value.length > 0) return mkProbe(id, label, 'pass', value, 'vcs');
  return mkProbe(id, label, 'warn', `${key} not set`, 'vcs', hint);
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
  if (r.ok) return mkProbe(id, label, 'pass', 'authenticated', group);
  const detail =
    r.stderr
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? 'not authenticated';
  return mkProbe(id, label, 'warn', detail, group, hint);
};

/** Storage paths to probe for readability + writability — data root and config root. */
const STORAGE_PATHS = [
  { id: 'data-root', label: 'Data root', path: (input: DoctorInput) => input.dataRoot },
  { id: 'config-root', label: 'Config root', path: (input: DoctorInput) => input.configRoot },
];

/**
 * Probe storage paths for readability and writability. Readability is checked for every path
 * first, then writability — preserves the historical probe order (`data-root`, `config-root`,
 * `data-root-writable`, `config-root-writable`) callers key off.
 */
export const probeStorageGroup = async (input: DoctorInput): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];
  for (const config of STORAGE_PATHS) {
    probes.push(await probePath(config.id, `${config.label} readable`, config.path(input), 'storage'));
  }
  for (const config of STORAGE_PATHS) {
    probes.push(await probeWritable(`${config.id}-writable`, `${config.label} writable`, config.path(input)));
  }
  return probes;
};

/** Probe settings file persistence. */
export const probeSettingsGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const SETTINGS_PERSISTED_ID = 'settings-persisted';
  const SETTINGS_PRESENT_LABEL = 'Settings file present';
  const settingsPath = deps.settingsRepo.path;
  const settingsExists = await deps.settingsRepo.exists();
  if (!settingsExists.ok) {
    const detail = `${settingsPath} — ${settingsExists.error.message}`;
    return [mkProbe(SETTINGS_PERSISTED_ID, SETTINGS_PRESENT_LABEL, 'fail', detail, 'settings')];
  }
  if (settingsExists.value) {
    return [mkProbe(SETTINGS_PERSISTED_ID, SETTINGS_PRESENT_LABEL, 'pass', settingsPath, 'settings')];
  }
  const detail = `${settingsPath} — using built-in defaults (first run)`;
  const hint = 'open the welcome flow to pick a provider and persist your settings';
  return [mkProbe(SETTINGS_PERSISTED_ID, SETTINGS_PRESENT_LABEL, 'warn', detail, 'settings', hint)];
};

/** `git config` identity keys to probe — `user.name` and `user.email`. */
const GIT_IDENTITY_KEYS = [
  {
    id: 'git-user-name',
    label: 'Git user.name',
    key: 'user.name',
    hint: 'run `git config --global user.name "<your name>"` so commits are attributed correctly',
  },
  {
    id: 'git-user-email',
    label: 'Git user.email',
    key: 'user.email',
    hint: 'run `git config --global user.email "<you@example.com>"` so commits are attributed correctly',
  },
];

/** Optional VCS-host CLIs to probe — install check, then (if present) its auth probe. */
const OPTIONAL_VCS_CLIS = [
  {
    idPrefix: 'gh',
    label: 'GitHub CLI (`gh`)',
    binary: 'gh',
    installHint: 'install gh from https://cli.github.com if you target GitHub',
    authArgs: ['auth', 'status'],
    authHint: 'run `gh auth login` to sign in',
  },
  {
    idPrefix: 'glab',
    label: 'GitLab CLI (`glab`)',
    binary: 'glab',
    installHint: 'install glab from https://gitlab.com/gitlab-org/cli if you target GitLab',
    authArgs: ['auth', 'status'],
    authHint: 'run `glab auth login` to sign in',
  },
];

/** Installed check + (if present) the auth probe for one optional VCS-host CLI. */
const probeOptionalVcsCli = async (
  deps: DoctorDeps,
  config: (typeof OPTIONAL_VCS_CLIS)[number]
): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];
  const installed = await deps.commandExists(config.binary);
  const detail = installed ? `${config.binary} found on PATH` : `${config.binary} not found on PATH`;
  probes.push(
    mkProbe(
      `${config.idPrefix}-installed`,
      `${config.label} installed`,
      installed ? 'pass' : 'warn',
      detail,
      'vcs',
      installed ? undefined : config.installHint
    )
  );
  if (installed) {
    probes.push(
      await probeCliAuth(
        `${config.idPrefix}-auth`,
        `${config.label} authenticated`,
        config.binary,
        config.authArgs,
        config.authHint,
        deps.runCommand
      )
    );
  }
  return probes;
};

/** Probe VCS tooling: git, GitHub CLI, GitLab CLI, and their authentication. */
export const probeVcsToolingGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const gitInstalled = await deps.commandExists('git');
  probes.push(
    mkProbe(
      'git-installed',
      'Git installed',
      gitInstalled ? 'pass' : 'fail',
      gitInstalled ? 'git found on PATH' : 'git not found on PATH',
      'vcs',
      gitInstalled ? undefined : 'install git — required for implement / review flows'
    )
  );
  if (gitInstalled) {
    for (const identity of GIT_IDENTITY_KEYS) {
      probes.push(await probeGitConfig(identity.id, identity.label, identity.key, deps.runCommand, identity.hint));
    }
  }

  for (const config of OPTIONAL_VCS_CLIS) {
    probes.push(...(await probeOptionalVcsCli(deps, config)));
  }

  return probes;
};

/** Probe AI provider CLIs and their authentication. */
export const probeAiProvidersGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const settings = await deps.settingsRepo.load();
  // Per-flow rows can each pick a provider; surface every provider that appears on any row
  // as "configured" so the doctor flags binaries the user actually relies on.
  const ai = settings.ok ? settings.value.ai : undefined;
  const configuredProviders: ReadonlySet<AiProvider> = new Set<AiProvider>(
    ai === undefined
      ? []
      : [
          ai.refine.provider,
          ai.plan.provider,
          ai.implement.generator.provider,
          ai.implement.evaluator.provider,
          ai.readiness.provider,
          ai.ideate.provider,
        ]
  );

  // Binary rows first (so a provider's PATH check always precedes its auth check), then one
  // auth row per provider that is both configured and confirmed installed — every provider
  // gets the same treatment now, not just codex. `probeProviderAuth` never returns 'fail'.
  const installedByProvider = new Map<AiProvider, boolean>();
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
    installedByProvider.set(provider, probe.status === 'pass');
    probes.push(probe.status === 'fail' ? { ...probe, status: 'warn' } : probe);
  }

  for (const provider of Object.keys(PROVIDER_BINARY) as readonly AiProvider[]) {
    if (!configuredProviders.has(provider) || installedByProvider.get(provider) !== true) continue;
    probes.push(await probeProviderAuth(provider, deps.runCommand));
  }

  return probes;
};

const probeProjectRepoPaths = async (projects: readonly Project[]): Promise<readonly ProbeResult[]> => {
  const out: ProbeResult[] = [];
  for (const project of projects) {
    const missing: string[] = [];
    for (const repo of project.repositories) {
      const r = await pathIsDirectory(String(repo.path));
      if (!r.ok || !r.value) missing.push(`${repo.slug} → ${String(repo.path)}`);
    }
    const id = `project-paths-${project.slug}`;
    const label = `Project '${project.slug}': repo paths resolve`;
    out.push(
      missing.length === 0
        ? mkProbe(id, label, 'pass', `${String(project.repositories.length)} repo(s) present`, 'integrity')
        : mkProbe(
            id,
            label,
            'fail',
            `missing: ${missing.join('; ')}`,
            'integrity',
            'remove the project, re-clone the repo, or update its path via the TUI'
          )
    );
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
      const id = `default-branch-${project.slug}-${repo.slug}`;
      const label = `${project.slug}/${repo.slug}: default branch`;
      out.push(
        result.ok && branch.length > 0
          ? mkProbe(id, label, 'pass', branch, 'integrity')
          : mkProbe(
              id,
              label,
              'warn',
              'no resolvable origin/HEAD',
              'integrity',
              `run \`git -C ${String(repo.path)} remote set-head origin --auto\` to discover it`
            )
      );
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
  const id = 'sprint-execution-pairing';
  const label = 'Pending sprints have a paired execution record';
  if (recoverable.length === 0) {
    return mkProbe(id, label, 'pass', `${String(sprints.length)} sprint(s) verified`, 'integrity');
  }
  return mkProbe(
    id,
    label,
    'warn',
    `missing execution for pending sprint(s): ${recoverable.join(', ')}`,
    'integrity',
    'recreate the execution by re-running create-sprint, or remove the sprint if it is no longer needed'
  );
};

/** Probe repository lists and data integrity. */
export const probeRepositoriesAndIntegrityGroup = async (deps: DoctorDeps): Promise<readonly ProbeResult[]> => {
  const probes: ProbeResult[] = [];

  const projects = await deps.projectRepo.list();
  probes.push(
    mkProbe(
      'projects-list',
      'Project repository responds',
      projects.ok ? 'pass' : 'fail',
      projects.ok ? `${String(projects.value.length)} project(s)` : projects.error.message,
      'repositories'
    )
  );

  const sprints = await deps.sprintRepo.list();
  probes.push(
    mkProbe(
      'sprints-list',
      'Sprint repository responds',
      sprints.ok ? 'pass' : 'fail',
      sprints.ok ? `${String(sprints.value.length)} sprint(s)` : sprints.error.message,
      'repositories'
    )
  );

  if (projects.ok && projects.value.length > 0) {
    probes.push(...(await probeProjectRepoPaths(projects.value)));
    probes.push(...(await probeProjectDefaultBranches(projects.value, deps.runCommand)));
  }

  if (sprints.ok && sprints.value.length > 0) {
    probes.push(await probeSprintExecutionPairing(sprints.value, deps.sprintExecutionRepo));
  }

  return probes;
};
