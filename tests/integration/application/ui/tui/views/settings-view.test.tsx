/**
 * Smoke tests for SettingsView. Renders the editable fields after the settings load, and the
 * status bar surfaces ↑/↓ + ↵/e hints.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeSettingsRepo: SettingsRepository = {
  path: '/tmp/test-settings.json',
  async exists() {
    return Result.ok(true);
  },
  async load() {
    return Result.ok(DEFAULT_SETTINGS);
  },
  async save() {
    return Result.ok(undefined);
  },
};

const deps: AppDeps = {
  settingsRepo: fakeSettingsRepo,
} as unknown as AppDeps;

const stubRepoWith = (settings: Settings): { readonly repo: SettingsRepository; saved: Settings | undefined } => {
  const state = { saved: undefined as Settings | undefined, current: settings };
  return {
    saved: state.saved,
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
    },
  };
};

describe('SettingsView', () => {
  it('renders every editable field after the load completes', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Provider');
    expect(frame).toContain('Refine');
    expect(frame).toContain('Plan');
    expect(frame).toContain('Implement');
    expect(frame).toContain('Max turns');
    expect(frame).toContain('Concurrency');
    expect(frame).toContain('Log level');
    result.unmount();
  });

  it('shows the storage paths card', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Storage paths');
    expect(frame).toContain('App root');
    result.unmount();
  });

  it('exposes ↑/↓ navigate and ↵/e edit hints', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('navigate');
    expect(frame).toContain('edit');
    result.unmount();
  });

  it('renders Implement as a parent label with indented generator and evaluator sub-rows', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // The parent card carries the non-editable Implement label exactly once; the two role
    // sub-rows render their own dim sub-labels underneath.
    expect(frame).toContain('AI — Implement');
    expect(frame).not.toContain('AI — Implement (generator)');
    expect(frame).not.toContain('AI — Implement (evaluator)');
    expect(frame).toContain('generator');
    expect(frame).toContain('evaluator');
    result.unmount();
  });

  it('persisting one role leaves the other role untouched on subsequent loads', async () => {
    // Start with a settings record where evaluator was customised — verify a generator-only
    // edit persists through the same disk surface without touching the evaluator row.
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        implement: {
          ...DEFAULT_SETTINGS.ai.implement,
          evaluator: { provider: 'openai-codex', model: 'gpt-5.5-pinned' },
        },
      },
    };
    const stub = stubRepoWith(initial);
    const role1Repo = stub.repo;
    // Drive a generator-only edit through the same code path the TUI uses: applySettingsKey
    // routes `ai.implement.generator.model` to set the generator's model. The evaluator slot
    // remains exactly as it was on load.
    const { applySettingsKey } = await import('@src/business/settings/apply-key.ts');
    const loaded = await role1Repo.load();
    if (!loaded.ok) throw new Error('expected ok load');
    const updated = applySettingsKey(loaded.value, 'ai.implement.generator.model', 'claude-haiku-4-5-20251001');
    if (!updated.ok) throw new Error(`expected updated ok: ${updated.error.message}`);
    await role1Repo.save(updated.value);

    const reread = await role1Repo.load();
    if (!reread.ok) throw new Error('expected reread ok');
    // Generator received the new model; evaluator is byte-for-byte the pre-edit value.
    expect(reread.value.ai.implement.generator.model).toBe('claude-haiku-4-5-20251001');
    expect(reread.value.ai.implement.evaluator).toEqual(initial.ai.implement.evaluator);
  });
});
