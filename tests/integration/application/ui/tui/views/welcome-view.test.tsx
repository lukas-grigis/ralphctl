/**
 * First-run UX coverage for WelcomeView. Asserts the provider picker renders, that selecting
 * one persists provider-keyed defaults via the settings-set flow, and that the post-save route
 * branches on whether the user already has any projects.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { WelcomeView } from '@src/application/ui/tui/views/welcome-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeProject } from '@tests/fixtures/domain.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

const fakeSettingsRepo = (save: (s: Settings) => Promise<Result<undefined, never>>): SettingsRepository => ({
  path: '/tmp/test-settings.json',
  async exists() {
    return Result.ok(false);
  },
  async load() {
    return Result.error(new Error('not saved yet')) as never;
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
  it('renders all three AI provider choices', async () => {
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async () => Result.ok(undefined)),
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const { result } = renderView(<WelcomeView />, { deps, initial: { id: 'welcome' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Welcome to ralphctl');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('GitHub Copilot');
    expect(frame).toContain('OpenAI Codex');
  });

  it('persists a provider-keyed settings record and routes to create-project when no project exists', async () => {
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
    await tick(60);
    result.stdin.write(ENTER); // accept default-highlighted "Claude Code"
    await tick(120);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.ai?.implement?.provider).toBe('claude-code');
    // Last route entry is the destination; first entry is the welcome view itself.
    expect(routes.at(-1)?.id).toBe('create-project');
  });

  it('routes to home (not create-project) when at least one project already exists', async () => {
    const deps: AppDeps = {
      settingsRepo: fakeSettingsRepo(async () => Result.ok(undefined)),
      projectRepo: fakeProjectRepo([makeProject()]),
    } as unknown as AppDeps;

    const routes: ViewEntry[] = [];
    const { result } = renderView(<WelcomeView />, {
      deps,
      initial: { id: 'welcome' },
      onRoute: (e) => routes.push(e),
    });
    await tick(60);
    result.stdin.write(ENTER);
    await tick(120);

    expect(routes.at(-1)?.id).toBe('home');
  });

  it('surfaces a "Failed to save settings" message when persistence fails', async () => {
    const fail = vi.fn(async () =>
      Result.error({ error: { message: 'disk full', code: 'storage-error' } })
    ) as unknown as SettingsRepository['save'];
    const deps: AppDeps = {
      settingsRepo: { ...fakeSettingsRepo(async () => Result.ok(undefined)), save: fail },
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const { result } = renderView(<WelcomeView />, { deps, initial: { id: 'welcome' } });
    await tick(60);
    result.stdin.write(ENTER);
    await tick(120);

    // Error-state branch rendered; the precise error string is wrapped by the leaf layer and
    // not the use case's job to reproduce. What this test guards is "the view doesn't crash and
    // does show the failure card" — the first-run path's critical UX requirement.
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Failed to save settings');
    expect(frame).toContain('Press esc to skip welcome');
  });
});
