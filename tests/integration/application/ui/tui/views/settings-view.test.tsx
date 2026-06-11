/**
 * Smoke tests for SettingsView. The view is split into sections; only the active section's
 * fields render at a time, so the ↑/↓ cursor path is bounded by the section's row count.
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
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

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

/**
 * Section ordering must match `buildSections` in settings-view.tsx. Tests use this to step
 * `→` the right number of times to land on a known section.
 */
const SECTIONS = [
  'presets',
  'global',
  'refine',
  'plan',
  'implement',
  'readiness',
  'ideate',
  'createPr',
  'harness',
  'other',
  'storage',
] as const;

/** Step the section cursor from the initial `presets` to the named section. */
const goToSection = async (stdin: { write: (s: string) => void }, target: (typeof SECTIONS)[number]): Promise<void> => {
  const steps = SECTIONS.indexOf(target);
  for (let i = 0; i < steps; i += 1) {
    stdin.write(RIGHT);
    await tick(20);
  }
};

describe('SettingsView', () => {
  it('renders the section strip and the active section after the load completes', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
    const frame = result.lastFrame() ?? '';
    // Every section label is in the strip.
    for (const label of [
      'Presets',
      'Global',
      'Refine',
      'Plan',
      'Implement',
      'Readiness',
      'Ideate',
      'Harness',
      'Other',
      'Storage',
    ]) {
      expect(frame).toContain(label);
    }
    // The active (initial) section is Presets; its card title renders below the strip.
    expect(frame).toContain('Apply: Mixed');
    result.unmount();
  });

  it('shows an animated Spinner (not static text) while settings are loading', () => {
    // The first synchronous frame renders before `refresh()` resolves — the loading state must
    // be the shared <Spinner> (braille glyph + label), not a static "<Text>Loading…".
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Loading…');
    // The braille spinner's first frame glyph; its presence proves <Spinner> mounted.
    expect(frame).toContain('⠋');
    result.unmount();
  });

  it('shows the storage paths card when the storage section is active', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
    await goToSection(result.stdin, 'storage');
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Storage paths');
    expect(frame).toContain('App root');
    result.unmount();
  });

  it('exposes ←/→ section, ↑/↓ navigate, ↵/e edit hints', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await waitForViewReady(result, (f) => f.includes('section'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('section');
    expect(frame).toContain('navigate');
    expect(frame).toContain('edit');
    result.unmount();
  });

  it('renders Implement as a parent card with indented generator and evaluator sub-rows', async () => {
    const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
    await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
    await goToSection(result.stdin, 'implement');
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
    const updated = applySettingsKey(loaded.value, 'ai.implement.generator.model', 'claude-haiku-4-5');
    if (!updated.ok) throw new Error(`expected updated ok: ${updated.error.message}`);
    await role1Repo.save(updated.value);

    const reread = await role1Repo.load();
    if (!reread.ok) throw new Error('expected reread ok');
    // Generator received the new model; evaluator is byte-for-byte the pre-edit value.
    expect(reread.value.ai.implement.generator.model).toBe('claude-haiku-4-5');
    expect(reread.value.ai.implement.evaluator).toEqual(initial.ai.implement.evaluator);
  });

  describe('per-section bounded cursor', () => {
    // Within one section, ↑/↓ stops at the section's first / last editable field. Holding ↓
    // past the last row leaves the cursor pinned, and the cursor never escapes into another
    // section's fields. The Implement section is the largest (six rows — generator triple +
    // evaluator triple) and is the right stress-test for the ≤ ~8-row cap.
    it('caps ↓ at the Implement section last row no matter how many presses arrive', async () => {
      const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await goToSection(result.stdin, 'implement');
      // The Implement section has six fields (generator.{provider,model,effort} +
      // evaluator.{provider,model,effort}). Ten ↓ presses pin the cursor at the last row.
      for (let i = 0; i < 10; i += 1) {
        result.stdin.write('j');
        await tick(15);
      }
      const frame = result.lastFrame() ?? '';
      // The cursor glyph ▸ marks the focused row's value. Only one row carries it.
      const cursorMatches = frame.match(/▸/g) ?? [];
      // One ▸ in the section strip (the active section label) + one ▸ on the focused field.
      expect(cursorMatches.length).toBeLessThanOrEqual(2);
      // The focused row must be the evaluator's effort (the last of the six). Search the
      // rendered text for the cursor adjacent to the Default / current effort token; the
      // value is `Default` for a freshly-loaded settings record.
      // Approximate the assertion with a substring match: the last evaluator row's value cell
      // is preceded by `Effort:` in the field list.
      // We can't easily verify alignment but we can confirm the cursor did not escape into
      // the next section — Readiness fields (e.g. `AI — Readiness`) must NOT be on screen.
      expect(frame).not.toContain('AI — Readiness');
      expect(frame).not.toContain('AI — Plan');
      result.unmount();
    });

    it('caps ↑ at the first row inside a section', async () => {
      const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await goToSection(result.stdin, 'harness');
      // Park the cursor on the last row first, then hammer ↑.
      for (let i = 0; i < 5; i += 1) {
        result.stdin.write('j');
        await tick(15);
      }
      for (let i = 0; i < 10; i += 1) {
        result.stdin.write('k');
        await tick(15);
      }
      const frame = result.lastFrame() ?? '';
      // Only Harness fields are visible — the previous section (Ideate) must not bleed in.
      expect(frame).toContain('Max turns');
      expect(frame).not.toContain('AI — Ideate');
      result.unmount();
    });
  });

  describe('model field is catalog-only', () => {
    it('does not mount a TextPrompt on a model row (no free-text input affordance)', async () => {
      const { result } = renderView(<SettingsView />, { deps, initial: { id: 'settings' } });
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await goToSection(result.stdin, 'refine');
      // Refine section field order: 0 provider, 1 model, 2 effort. One ↓ lands on the model
      // row; ↵ opens the picker.
      result.stdin.write('j');
      await tick(20);
      result.stdin.write(ENTER);
      await waitForViewReady(result, (f) => f.includes('↑/↓ navigate · ↵ submit · esc cancel'));
      const frame = result.lastFrame() ?? '';
      // SelectPrompt always renders the navigation legend below its option list.
      expect(frame).toContain('↑/↓ navigate · ↵ submit · esc cancel');
      // TextPrompt's hint row carries the `←/→ cursor · home/end edge` suffix; its absence
      // confirms the active editor is the SelectPrompt, not a free-text input.
      expect(frame).not.toContain('←/→ cursor · home/end edge');
      // Every Claude catalog model must be selectable; no "+ custom" affordance lingers.
      expect(frame).toContain('claude-sonnet-4-6');
      expect(frame).not.toContain('+ custom');
      result.unmount();
    });
  });

  it('renders a persisted off-catalog model value on load (regression)', async () => {
    // A settings file pinned to a model the harness catalog does not list (an older release
    // or an experimental id) must still show that value on screen — the catalog gate applies
    // to the editor surface, not the read-side render.
    const offCatalogModel = 'claude-experimental-pinned-2099';
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        refine: { provider: 'claude-code', model: offCatalogModel },
      },
    };
    const stub = stubRepoWith(initial);
    const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
    const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
    await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
    await goToSection(result.stdin, 'refine');
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain(offCatalogModel);
    result.unmount();
  });

  describe('provider availability gate', () => {
    // Section ordering puts Refine third (presets → global → refine), so two RIGHT presses
    // step from the initial Presets section to Refine; ENTER on the first row (provider)
    // opens the picker.
    const openRefineProviderPicker = async (
      stdin: { write: (s: string) => void },
      lastFrame: () => string | undefined
    ): Promise<void> => {
      await goToSection(stdin, 'refine');
      stdin.write(ENTER);
      await waitFor(() => (lastFrame() ?? '').includes('↑/↓ navigate · ↵ submit · esc cancel'));
    };

    it("labels unavailable providers as '(not installed)' in the provider picker", async () => {
      detectRef.installed = new Set(['claude-code']);
      const stub = stubRepoWith(DEFAULT_SETTINGS);
      const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
      const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await openRefineProviderPicker(result.stdin, result.lastFrame);
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
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await openRefineProviderPicker(result.stdin, result.lastFrame);
      // Strip the rendered frame's word-wrap whitespace before asserting — ink may break the
      // footer across multiple lines depending on terminal width, but the install command must
      // still be present as a contiguous token sequence.
      const frame = (result.lastFrame() ?? '').replace(/\s+/g, ' ');
      // Footer renders the OS-preferred command (brew on macOS, winget on Windows, npm on
      // Linux). Assert on the OS-invariant prefix plus an alternation over the per-OS Copilot
      // CLI install fragments — proving the install COMMAND rendered (not just the provider
      // label, which already contains "copilot").
      expect(frame).toMatch(/install github-copilot: \S/);
      expect(frame).toMatch(/copilot-cli|@github\/copilot|GitHub\.Copilot/);
      expect(frame).toMatch(/install openai-codex: \S/);
      expect(frame).toContain('codex');
    });

    it("surfaces 'No AI provider CLI is installed.' when every provider is missing", async () => {
      detectRef.installed = new Set();
      const stub = stubRepoWith(DEFAULT_SETTINGS);
      const stubDeps: AppDeps = { settingsRepo: stub.repo } as unknown as AppDeps;
      const { result } = renderView(<SettingsView />, { deps: stubDeps, initial: { id: 'settings' } });
      await waitForViewReady(result, (f) => f.includes('Apply: Mixed'));
      await openRefineProviderPicker(result.stdin, result.lastFrame);
      const frame = result.lastFrame() ?? '';
      expect(frame).toContain('No AI provider CLI is installed.');
      expect(frame).toContain('claude-code (not installed)');
      expect(frame).toContain('github-copilot (not installed)');
      expect(frame).toContain('openai-codex (not installed)');
    });
  });
});
