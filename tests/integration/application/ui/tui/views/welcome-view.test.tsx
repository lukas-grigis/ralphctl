/**
 * First-run UX coverage for WelcomeView. The view auto-detects installed AI CLIs on mount and
 * silently seeds the matching preset — there is no manual provider picker. Tests mock the
 * detect-cli module so behavior is deterministic regardless of what's on the host's PATH.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { WelcomeView } from '@src/application/ui/tui/views/welcome-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeProject } from '@tests/fixtures/domain.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

// Hoisted state holder — each test mutates this before rendering so the mocked
// `detectInstalledProviders` returns the desired set. `vi.hoisted` ensures it exists when the
// mock factory is hoisted above the imports.
const detectRef = vi.hoisted(() => ({ installed: new Set<string>() }));

vi.mock('@src/integration/system/detect-cli.ts', () => ({
  detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
    new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  PROVIDER_BINARY: { 'claude-code': 'claude', 'github-copilot': 'copilot', 'openai-codex': 'codex' },
}));

const fakeSettingsRepo = (save: (s: Settings) => Promise<Result<undefined, never>>): SettingsRepository => ({
  path: '/tmp/test-settings.json',
  async exists() {
    return Result.ok(false);
  },
  async load() {
    return Result.ok(DEFAULT_SETTINGS);
  },
  save: save as SettingsRepository['save'],
});

const fakeProjectRepo = (projects: readonly Project[]): ProjectRepository =>
  ({
    async list() {
      return Result.ok(projects);
    },
  }) as unknown as ProjectRepository;

describe('WelcomeView — first-run UX', () => {
  it('seeds the claude-only preset silently when only claude is on PATH', async () => {
    detectRef.installed = new Set(['claude-code']);
    const saved: Settings[] = [];
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async (s) => {
        saved.push(s);
        return Result.ok(undefined);
      }),
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const routes: ViewEntry[] = [];
    const { result } = renderView(<WelcomeView />, {
      deps,
      initial: { id: 'welcome' },
      onRoute: (e) => routes.push(e),
    });
    await tick(120);

    expect(saved).toHaveLength(1);
    for (const flow of ['refine', 'plan', 'readiness', 'ideate'] as const) {
      expect(saved[0]?.ai[flow].provider).toBe('claude-code');
    }
    expect(saved[0]?.ai.implement.generator.provider).toBe('claude-code');
    expect(saved[0]?.ai.implement.evaluator.provider).toBe('claude-code');
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('claude-only');
    // A CLI was detected, so the copy claims a detection-based choice — not the zero-CLI warning.
    expect(frame).toContain('based on detected CLIs');
    expect(frame).not.toContain('No AI CLIs detected');
    expect(frame).not.toContain('Pick an AI provider');
    expect(routes.at(-1)?.id).toBe('create-project');
  });

  it('seeds the mixed preset silently when zero CLIs are on PATH', async () => {
    detectRef.installed = new Set();
    const saved: Settings[] = [];
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async (s) => {
        saved.push(s);
        return Result.ok(undefined);
      }),
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const { result } = renderView(<WelcomeView />, { deps, initial: { id: 'welcome' } });
    await tick(120);

    expect(saved).toHaveLength(1);
    // The mixed preset routes refine → codex, implement → claude — a clean fingerprint.
    expect(saved[0]?.ai.refine.provider).toBe('openai-codex');
    expect(saved[0]?.ai.implement.generator.provider).toBe('claude-code');
    const frame = result.lastFrame() ?? '';
    // Zero CLIs on PATH: the copy must NOT claim a detection-based choice (there was nothing to
    // detect). It warns + points to install + doctor, and labels the mixed seed a placeholder.
    expect(frame).toContain('No AI CLIs detected');
    expect(frame).toContain('doctor');
    expect(frame).not.toContain('based on detected CLIs');
    expect(frame).toContain('mixed');
  });

  it('seeds the mixed preset silently when 2+ CLIs are on PATH', async () => {
    detectRef.installed = new Set(['claude-code', 'github-copilot']);
    const saved: Settings[] = [];
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async (s) => {
        saved.push(s);
        return Result.ok(undefined);
      }),
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const { result } = renderView(<WelcomeView />, { deps, initial: { id: 'welcome' } });
    await tick(120);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.ai.refine.provider).toBe('openai-codex');
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('mixed');
  });

  it('routes to home (not create-project) when at least one project already exists', async () => {
    detectRef.installed = new Set(['openai-codex']);
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async () => Result.ok(undefined)),
      projectRepo: fakeProjectRepo([makeProject()]),
    } as unknown as AppDeps;

    const routes: ViewEntry[] = [];
    renderView(<WelcomeView />, {
      deps,
      initial: { id: 'welcome' },
      onRoute: (e) => routes.push(e),
    });
    await tick(120);

    expect(routes.at(-1)?.id).toBe('home');
  });

  it('surfaces a "Failed to save settings" message when persistence fails', async () => {
    detectRef.installed = new Set(['claude-code']);
    const fail = vi.fn(async () =>
      Result.error({ error: { message: 'disk full', code: 'storage-error' } })
    ) as unknown as SettingsRepository['save'];
    const deps: AppDeps = {
      settingsRepo: { ...fakeSettingsRepo(async () => Result.ok(undefined)), save: fail },
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const { result } = renderView(<WelcomeView />, { deps, initial: { id: 'welcome' } });
    await tick(120);

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Failed to save settings');
    expect(frame).toContain('Press esc to skip welcome');
  });
});
