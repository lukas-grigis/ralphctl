/**
 * SettingsView — escalation-map editing end-to-end.
 *
 * Drives the harness section's map group through the real prompt machinery: the add-rung row
 * walks a two-step from/to picker and persists `harness.escalationMap.<from>`; the per-entry
 * row re-renders after the refresh; the effective-ladder summary marks the customised chain.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { ENTER, RIGHT, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set<AiProvider>(['claude-code', 'github-copilot', 'openai-codex']),
  };
});

const stubRepo = (): { readonly repo: SettingsRepository; readonly saved: () => Settings | undefined } => {
  const state = { saved: undefined as Settings | undefined, current: DEFAULT_SETTINGS };
  return {
    saved: () => state.saved,
    repo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(state.current);
      },
      async save(next: Settings) {
        state.saved = next;
        state.current = next;
        return Result.ok(undefined);
      },
    } as unknown as SettingsRepository,
  };
};

/** Section order mirrors buildSections — harness is 8 `→` presses from the initial presets. */
const goToHarness = async (stdin: { write: (s: string) => void }): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    stdin.write(RIGHT);
    await tick(20);
  }
};

describe('SettingsView — escalation map editor', () => {
  it('adds a rung via the two-step picker and renders the new override row', async () => {
    const { repo, saved } = stubRepo();
    const deps = { settingsRepo: repo } as unknown as AppDeps;
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });

    await waitFor(() => (result.lastFrame() ?? '').includes('Presets'));
    await goToHarness(result.stdin);
    await waitFor(() => (result.lastFrame() ?? '').includes('Escalation map'));

    // The defaults summary is visible before any override exists.
    expect(result.lastFrame() ?? '').toContain('Effective ladder');
    expect(result.lastFrame() ?? '').toContain('defaults apply');

    // Cursor: 7 knob rows precede the map-add row.
    for (let i = 0; i < 7; i += 1) {
      result.stdin.write('j');
      await tick(15);
    }
    result.stdin.write(ENTER);
    await waitFor(() => (result.lastFrame() ?? '').includes('step 1/2'));

    // Step 1 — first catalog entry is claude-haiku-4-5.
    result.stdin.write(ENTER);
    await waitFor(() => (result.lastFrame() ?? '').includes('step 2/2'));
    expect(result.lastFrame() ?? '').toContain('claude-haiku-4-5');

    // Step 2 — first compatible target is claude-sonnet-4-6.
    result.stdin.write(ENTER);
    await waitFor(() => saved() !== undefined);

    expect(saved()?.harness.escalationMap).toEqual({ 'claude-haiku-4-5': 'claude-sonnet-4-6' });

    // Back on the section: the override row + customised ladder render after the refresh.
    await waitFor(() => (result.lastFrame() ?? '').includes('1 override'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('claude-haiku-4-5');
    expect(frame).toContain('(customised)');
    expect(frame).toContain('escalation rung added');
  });

  it('esc on step 2 returns to the from-model pick instead of abandoning the add', async () => {
    const { repo, saved } = stubRepo();
    const deps = { settingsRepo: repo } as unknown as AppDeps;
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });

    await waitFor(() => (result.lastFrame() ?? '').includes('Presets'));
    await goToHarness(result.stdin);
    await waitFor(() => (result.lastFrame() ?? '').includes('Escalation map'));
    for (let i = 0; i < 7; i += 1) {
      result.stdin.write('j');
      await tick(15);
    }
    result.stdin.write(ENTER);
    await waitFor(() => (result.lastFrame() ?? '').includes('step 1/2'));
    result.stdin.write(ENTER);
    await waitFor(() => (result.lastFrame() ?? '').includes('step 2/2'));

    result.stdin.write(String.fromCharCode(27)); // esc
    await waitFor(() => (result.lastFrame() ?? '').includes('step 1/2'));

    expect(saved()).toBeUndefined();
  });
});
