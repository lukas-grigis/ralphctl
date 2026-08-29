/**
 * Regression: the welcome error card advertises `esc`, so `esc` has to do something.
 *
 * The seeding hook only ever set `pendingRoute` on the SUCCESS + zero-CLI branch, which left the
 * local escape handler (and the ↵/space dispatcher, and the `claimEscape` that keeps the global
 * `router.pop()` out of the way) muted on the error branch. Welcome is the root of the router
 * stack, so the fall-through `router.pop()` was a no-op too: the operator pressed the key the
 * screen named and nothing happened at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { WelcomeView } from '@src/application/ui/tui/views/welcome-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { ENTER, ESC } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const detectRef = vi.hoisted(() => ({ installed: new Set<string>(['claude-code']) }));

vi.mock('@src/integration/system/detect-cli.ts', () => ({
  detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
    new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  PROVIDER_BINARY: {
    'claude-code': 'claude',
    'github-copilot': 'copilot',
    'openai-codex': 'codex',
    opencode: 'opencode',
    'xai-grok': 'grok',
  },
}));

/** A settings repo whose `save` always fails — the branch that renders the error card. */
const failingDeps = (): AppDeps =>
  ({
    settingsRepo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(false);
      },
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
      save: (async () =>
        Result.error({
          error: { message: 'disk full', code: 'storage-error' },
        })) as unknown as SettingsRepository['save'],
    } as unknown as SettingsRepository,
    projectRepo: {
      async list() {
        return Result.ok([]);
      },
    } as unknown as ProjectRepository,
  }) as unknown as AppDeps;

const renderFailedWelcome = async (): Promise<{
  readonly result: ReturnType<typeof renderView>['result'];
  readonly routes: ViewEntry[];
}> => {
  const routes: ViewEntry[] = [];
  const { result } = renderView(<WelcomeView />, {
    deps: failingDeps(),
    initial: { id: 'welcome' },
    onRoute: (e) => routes.push(e),
  });
  await waitForViewReady(result, (f) => f.includes('Failed to save settings'));
  return { result, routes };
};

describe("WelcomeView — the error card's escape hatch actually works", () => {
  it('routes to home on esc', async () => {
    const { result, routes } = await renderFailedWelcome();
    expect(routes.at(-1)?.id).toBe('welcome');

    result.stdin.write(ESC);
    await waitForPredicate(() => routes.at(-1)?.id === 'home');

    expect(routes.at(-1)?.id).toBe('home');
    result.unmount();
  });

  it('routes to home on ↵ as well, so the hinted continue key is not a lie', async () => {
    const { result, routes } = await renderFailedWelcome();

    result.stdin.write(ENTER);
    await waitForPredicate(() => routes.at(-1)?.id === 'home');

    expect(routes.at(-1)?.id).toBe('home');
    result.unmount();
  });

  it('keeps advertising esc while the gate is up', async () => {
    const { result } = await renderFailedWelcome();

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Failed to save settings');
    expect(frame).toContain('Press esc to skip welcome');
    result.unmount();
  });
});
