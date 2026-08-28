/**
 * WelcomeView seeding must be idempotent against DISK, not just against its own component
 * instance. The old guard was a per-instance `useRef`, so any re-mount of the view (the `h` /
 * `D` chords used to do exactly that on a first-run session) re-ran the PATH probe and
 * re-applied the AI preset — `applyPreset` replaces the whole `ai` section, silently clobbering
 * anything the user had just configured in Settings during the same session.
 *
 * The view's own header comment asserts the invariant: "an existing settings file means the
 * user already set up readiness", so a mount that finds one must route onward without writing.
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
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeProject } from '@tests/fixtures/domain.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

const detectRef = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@src/integration/system/detect-cli.ts', () => ({
  detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> => {
    detectRef.calls += 1;
    return new Set<AiProvider>(['claude-code']);
  },
  PROVIDER_BINARY: {
    'claude-code': 'claude',
    'github-copilot': 'copilot',
    'openai-codex': 'codex',
    opencode: 'opencode',
    'xai-grok': 'grok',
  },
}));

const settingsRepoWith = (exists: boolean, save: (s: Settings) => void): SettingsRepository => ({
  path: '/tmp/test-settings.json',
  async exists() {
    return Result.ok(exists);
  },
  async load() {
    return Result.ok(DEFAULT_SETTINGS);
  },
  save: (async (s: Settings) => {
    save(s);
    return Result.ok(undefined);
  }) as unknown as SettingsRepository['save'],
});

const fakeProjectRepo = (projects: readonly Project[]): ProjectRepository =>
  ({
    async list() {
      return Result.ok(projects);
    },
  }) as unknown as ProjectRepository;

describe('WelcomeView — disk-backed seed idempotence', () => {
  it('never re-applies the preset when a settings file already exists', async () => {
    detectRef.calls = 0;
    const saved: Settings[] = [];
    const deps: AppDeps = {
      settingsRepo: settingsRepoWith(true, (s) => saved.push(s)),
      projectRepo: fakeProjectRepo([makeProject()]),
    } as unknown as AppDeps;

    const routes: ViewEntry[] = [];
    renderView(<WelcomeView />, { deps, initial: { id: 'welcome' }, onRoute: (e) => routes.push(e) });
    await waitForPredicate(() => routes.at(-1)?.id === 'home');

    expect(saved).toHaveLength(0);
    expect(detectRef.calls).toBe(0);
  });

  it('still seeds (and routes on) when no settings file exists yet', async () => {
    detectRef.calls = 0;
    const saved: Settings[] = [];
    const deps: AppDeps = {
      settingsRepo: settingsRepoWith(false, (s) => saved.push(s)),
      projectRepo: fakeProjectRepo([]),
    } as unknown as AppDeps;

    const routes: ViewEntry[] = [];
    renderView(<WelcomeView />, { deps, initial: { id: 'welcome' }, onRoute: (e) => routes.push(e) });
    await waitForPredicate(() => routes.at(-1)?.id === 'create-project');

    expect(saved).toHaveLength(1);
    // The seeding path probes PATH (the view's own probe plus the apply-preset flow's) — the
    // exact count is an implementation detail, "at least once" is the behaviour under test.
    expect(detectRef.calls).toBeGreaterThan(0);
  });
});
