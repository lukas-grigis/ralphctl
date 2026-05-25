/**
 * Smoke tests for SettingsView. Renders the editable fields after the settings load, and the
 * status bar surfaces ↑/↓ + ↵/e hints.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

// Hoisted state holder — each test mutates this before rendering so the mocked
// `detectInstalledProviders` returns the desired set. The mock targets the integration
// module rather than the SettingsView itself so the view's import is exercised end-to-end.
const detectRef = vi.hoisted(() => ({ installed: new Set<AiProvider>() }));

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
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

  describe('provider availability gate', () => {
    // Field order (built in buildEditableFields): four preset buttons, global effort, then six
    // provider/model/effort triples per flow + the implement pair. Refine is the first flow
    // after the four presets + global effort, so its provider field sits at index 5 (zero-indexed):
    // [preset×4, ai.effort, ai.refine.provider]. Five 'j' presses move from cursor 0 (the first
    // preset) to cursor 5 (ai.refine.provider), where the picker opens.
    const navigateToRefineProvider = async (stdin: { write: (s: string) => void }): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        stdin.write('j');
        await tick(20);
      }
      stdin.write(ENTER);
      await tick(40);
    };

    it("labels unavailable providers as '(not installed)' in the provider picker", async () => {
      detectRef.installed = new Set(['claude-code']);
      const stub = stubRepoWith(DEFAULT_SETTINGS);
      const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
      const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
      await tick(80);
      await navigateToRefineProvider(result.stdin);
      const frame = result.lastFrame() ?? '';
      expect(frame).toContain('github-copilot (not installed)');
      expect(frame).toContain('openai-codex (not installed)');
      // claude-code stays plain (no '(not installed)' suffix); detect a substring that the
      // unavailable row cannot accidentally match.
      expect(frame).toMatch(/claude-code(?! \(not installed\))/);
    });

    it('surfaces the install command in the picker footer when a provider is unavailable', async () => {
      detectRef.installed = new Set(['claude-code']);
      const stub = stubRepoWith(DEFAULT_SETTINGS);
      const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
      const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
      await tick(80);
      await navigateToRefineProvider(result.stdin);
      // Strip the rendered frame's word-wrap whitespace before asserting — ink may break the
      // footer across multiple lines depending on terminal width, but the install command must
      // still be present as a contiguous token sequence.
      const frame = (result.lastFrame() ?? '').replace(/\s+/g, ' ');
      // Footer renders the OS-preferred command (brew on macOS, winget on Windows, the curl
      // installer / gh-install hint on Linux). Assert on the OS-invariant prefix and the
      // command fragment that every option references.
      expect(frame).toMatch(/install github-copilot: \S/);
      expect(frame).toContain('gh-copilot');
      expect(frame).toMatch(/install openai-codex: \S/);
      expect(frame).toContain('codex');
    });

    it("surfaces 'No AI provider CLI is installed.' when every provider is missing", async () => {
      detectRef.installed = new Set();
      const stub = stubRepoWith(DEFAULT_SETTINGS);
      const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
      const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
      await tick(80);
      await navigateToRefineProvider(result.stdin);
      const frame = result.lastFrame() ?? '';
      expect(frame).toContain('No AI provider CLI is installed.');
      expect(frame).toContain('claude-code (not installed)');
      expect(frame).toContain('github-copilot (not installed)');
      expect(frame).toContain('openai-codex (not installed)');
    });
  });
});
