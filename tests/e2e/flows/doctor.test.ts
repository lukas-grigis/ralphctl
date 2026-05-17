import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createDoctorFlow } from '@src/application/flows/doctor/flow.ts';

const fakeProjectRepo = (override?: Partial<ProjectRepository>): ProjectRepository =>
  ({
    async list() {
      return Result.ok([]);
    },
    ...override,
  }) as ProjectRepository;

const fakeSprintRepo = (override?: Partial<SprintRepository>): SprintRepository =>
  ({
    async list() {
      return Result.ok([]);
    },
    ...override,
  }) as SprintRepository;

const fakeSprintExecutionRepo = (override?: Partial<SprintExecutionRepository>): SprintExecutionRepository =>
  ({
    async findById(id: unknown) {
      return Result.error(
        new NotFoundError({ entity: 'sprint-execution', id: String(id), message: 'stub: no executions' })
      );
    },
    ...override,
  }) as SprintExecutionRepository;

const fakeSettingsRepo = (overrides?: Partial<SettingsRepository>): SettingsRepository => ({
  path: '/tmp/ralphctl-doctor-test/settings.json',
  async exists() {
    return Result.ok(true);
  },
  async load() {
    return Result.ok(DEFAULT_SETTINGS);
  },
  async save() {
    return Result.ok(undefined);
  },
  ...overrides,
});

const stubCommandExists =
  (installed: boolean): ((name: string) => Promise<boolean>) =>
  async () =>
    installed;

/**
 * Default stub: returns `ok: true` with empty output for every command. Tests that care about
 * specific commands override.
 */
const stubRunCommand =
  (
    override?: (name: string, args: readonly string[]) => { ok: boolean; stdout?: string; stderr?: string } | undefined
  ): RunCommand =>
  async (name, args) => {
    const r = override?.(name, args);
    if (r !== undefined) {
      return { ok: r.ok, code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    return { ok: true, code: 0, stdout: 'stub-value', stderr: '' };
  };

describe('doctor use-case', () => {
  let dataDir: string;
  let configDir: string;

  beforeAll(async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-doctor-'));
    dataDir = join(root, 'data');
    configDir = join(root, 'config');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
  });

  afterAll(async () => {
    if (dataDir) await fs.rm(join(dataDir, '..'), { recursive: true, force: true });
  });

  it('reports all probes passing on a fully healthy install', async () => {
    const flow = createDoctorFlow({
      projectRepo: fakeProjectRepo(),
      sprintRepo: fakeSprintRepo(),
      settingsRepo: fakeSettingsRepo(),
      commandExists: stubCommandExists(true),
      runCommand: stubRunCommand(),
      sprintExecutionRepo: fakeSprintExecutionRepo(),
      nodeVersion: 'v24.0.0',
    });
    const result = await flow.execute({
      input: { dataRoot: absolutePath(dataDir), configRoot: absolutePath(configDir) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.ctx.output!;
    expect(report.allPassed).toBe(true);
    expect(report.hasFailures).toBe(false);
    expect(report.probes.map((p) => p.id)).toEqual([
      'data-root',
      'config-root',
      'data-root-writable',
      'config-root-writable',
      'node-version',
      'settings-persisted',
      'git-installed',
      'git-user-name',
      'git-user-email',
      'gh-installed',
      'gh-auth',
      'glab-installed',
      'glab-auth',
      'ai-claude-code',
      'ai-github-copilot',
      'ai-openai-codex',
      'projects-list',
      'sprints-list',
    ]);
    expect(report.probes.every((p) => p.status === 'pass')).toBe(true);
  });

  it('warns (does not fail) when settings have not yet been persisted — first-run signal', async () => {
    const flow = createDoctorFlow({
      projectRepo: fakeProjectRepo(),
      sprintRepo: fakeSprintRepo(),
      settingsRepo: fakeSettingsRepo({
        async exists() {
          return Result.ok(false);
        },
      }),
      commandExists: stubCommandExists(true),
      runCommand: stubRunCommand(),
      sprintExecutionRepo: fakeSprintExecutionRepo(),
      nodeVersion: 'v24.0.0',
    });
    const result = await flow.execute({
      input: { dataRoot: absolutePath(dataDir), configRoot: absolutePath(configDir) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.ctx.output!;
    const probe = report.probes.find((p) => p.id === 'settings-persisted');
    expect(probe?.status).toBe('warn');
    expect(probe?.hint).toContain('welcome');
    expect(report.allPassed).toBe(false);
    expect(report.hasFailures).toBe(false); // warn ≠ fail
  });

  it('warns (does not fail) when the configured provider CLI is not on PATH', async () => {
    const flow = createDoctorFlow({
      projectRepo: fakeProjectRepo(),
      sprintRepo: fakeSprintRepo(),
      settingsRepo: fakeSettingsRepo(),
      commandExists: stubCommandExists(false),
      runCommand: stubRunCommand(),
      sprintExecutionRepo: fakeSprintExecutionRepo(),
      nodeVersion: 'v24.0.0',
    });
    const result = await flow.execute({
      input: { dataRoot: absolutePath(dataDir), configRoot: absolutePath(configDir) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // DEFAULT_SETTINGS configures claude-code. Missing CLI is a warning, not a failure —
    // the user may be on a fresh shell or evaluating before committing to a provider.
    const configuredProbe = result.value.ctx.output!.probes.find((p) => p.id === 'ai-claude-code');
    expect(configuredProbe?.status).toBe('warn');
    expect(configuredProbe?.hint).toContain('install');
  });

  it('reports the missing-root probe as failed without erroring', async () => {
    const flow = createDoctorFlow({
      projectRepo: fakeProjectRepo(),
      sprintRepo: fakeSprintRepo(),
      settingsRepo: fakeSettingsRepo(),
      commandExists: stubCommandExists(true),
      runCommand: stubRunCommand(),
      sprintExecutionRepo: fakeSprintExecutionRepo(),
      nodeVersion: 'v24.0.0',
    });
    const result = await flow.execute({
      input: { dataRoot: absolutePath('/nonexistent/ralphctl-doctor-test'), configRoot: absolutePath(configDir) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.hasFailures).toBe(true);
    const dataProbe = result.value.ctx.output!.probes.find((p) => p.id === 'data-root');
    expect(dataProbe?.status).toBe('fail');
  });

  it('flags the projects-list probe when the repository errors', async () => {
    const failingRepo = fakeProjectRepo({
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'boom', path: dataDir }));
      },
    });
    const flow = createDoctorFlow({
      projectRepo: failingRepo,
      sprintRepo: fakeSprintRepo(),
      settingsRepo: fakeSettingsRepo(),
      commandExists: stubCommandExists(true),
      runCommand: stubRunCommand(),
      sprintExecutionRepo: fakeSprintExecutionRepo(),
      nodeVersion: 'v24.0.0',
    });
    const result = await flow.execute({
      input: { dataRoot: absolutePath(dataDir), configRoot: absolutePath(configDir) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const probe = result.value.ctx.output!.probes.find((p) => p.id === 'projects-list');
    expect(probe?.status).toBe('fail');
    expect(probe?.detail).toContain('boom');
  });
});
