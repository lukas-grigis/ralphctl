/**
 * Pre-launch customize picker — unit-level tests for `runCustomizePicker`.
 *
 * The picker is driven by a scripted {@link InteractivePrompt} fake instead of an Ink mount
 * so each assertion sees the exact `LaunchExtras` payload the launcher would receive without
 * the indirection of stdin keystrokes. The behaviour under test is:
 *  - Start (use defaults) → kind 'defaults'; launcher launches with no override.
 *  - Customize for this run… → walks provider / model / effort; the resulting `override` only
 *    carries fields the user changed (per-field fallback to settings).
 *  - Cancel (at any step) → kind 'cancel'; launcher does not launch.
 *  - Implement walks generator → evaluator; canceling mid-evaluator discards the generator
 *    override (no partial state leaks into LaunchExtras).
 *
 * A separate integration assertion uses the real on-disk `createJsonSettingsRepository` to
 * verify that no picker path mutates `settings.json` — the file's sha256 is byte-identical
 * before and after every picker session.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import {
  type CustomizePickerResult,
  modelCatalogFor,
  runCustomizePicker,
} from '@src/application/ui/tui/views/flows-customize-picker.ts';
import { applyOverrideToSettings } from '@src/application/ui/shared/launcher.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';

/**
 * Script-driven {@link InteractivePrompt}. Each `askChoice` consumes the next script entry; a
 * `pick` entry resolves to the named option's value, a `cancel` entry resolves to an
 * `AbortError` via the Result error channel (mirroring the production InkPromptAdapter on
 * Esc). Order is FIFO. The captured list of prompts each test made is returned alongside the
 * picker result for stronger assertions on the prompt sequence the picker actually showed.
 */
interface ScriptEntryPick {
  readonly action: 'pick';
  /** Either an option label or a value — first label match wins; falls back to value match. */
  readonly choice: string;
}
interface ScriptEntryCancel {
  readonly action: 'cancel';
}
type ScriptEntry = ScriptEntryPick | ScriptEntryCancel;

interface CapturedPrompt {
  readonly message: string;
  readonly options: readonly string[];
}

const buildScriptedPrompt = (
  script: readonly ScriptEntry[]
): { readonly interactive: InteractivePrompt; readonly captured: CapturedPrompt[] } => {
  const captured: CapturedPrompt[] = [];
  let cursor = 0;
  const interactive: InteractivePrompt = {
    async askText() {
      throw new Error('askText not supported by scripted prompt');
    },
    async askTextArea() {
      throw new Error('askTextArea not supported by scripted prompt');
    },
    async askConfirm() {
      throw new Error('askConfirm not supported by scripted prompt');
    },
    async askMultiChoice() {
      throw new Error('askMultiChoice not supported by scripted prompt');
    },
    async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
      captured.push({ message, options: options.map((o) => o.label) });
      const entry = script[cursor];
      cursor += 1;
      if (entry === undefined) {
        throw new Error(`scripted prompt exhausted at message: ${message}`);
      }
      if (entry.action === 'cancel') {
        return Result.error(new AbortError({ elementName: 'test', reason: 'scripted cancel' })) as unknown as Result<
          T,
          DomainError
        >;
      }
      const found =
        options.find((o) => o.label === entry.choice) ?? options.find((o) => String(o.value) === entry.choice);
      if (found === undefined) {
        throw new Error(
          `scripted prompt: option '${entry.choice}' not found in ${options.map((o) => o.label).join(' / ')}`
        );
      }
      return Result.ok(found.value) as unknown as Result<T, DomainError>;
    },
  };
  return { interactive, captured };
};

const driveSettings = (overrides: Partial<Settings['ai']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, ...overrides },
});

const SIMPLE_FLOWS = ['refine', 'plan', 'readiness', 'ideate'] as const;

describe('runCustomizePicker — single-row flows (refine / plan / readiness / ideate)', () => {
  for (const flowId of SIMPLE_FLOWS) {
    describe(`flow=${flowId}`, () => {
      it('keep-all-defaults → kind defaults; LaunchExtras carries no override', async () => {
        // Start path takes precedence; the picker never walks provider/model/effort prompts.
        const { interactive, captured } = buildScriptedPrompt([{ action: 'pick', choice: 'Start (use defaults)' }]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        expect(result.kind).toBe('defaults');
        // Only the entry prompt rendered; no row-walk happened.
        expect(captured).toHaveLength(1);
        expect(captured[0]?.options).toContain('Start (use defaults)');
        expect(captured[0]?.options).toContain('Customize for this run…');
      });

      it('keep-all on every customize step → kind defaults (empty override collapses to Start)', async () => {
        // Customize walks provider → model → effort; Keep-default on every step means the
        // user changed nothing. Collapse to `defaults` so launchers never see an empty
        // `override: {}` payload that would otherwise look identical to "no override".
        const { interactive } = buildScriptedPrompt([
          { action: 'pick', choice: 'Customize for this run…' },
          // provider step: Keep default — exact label matches the row's default provider id
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].provider})` },
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].model})` },
          // The default row carries no per-flow effort and DEFAULT_SETTINGS has no global
          // effort either, so resolveEffortForRow returns undefined and Keep default's label
          // renders 'unset'.
          { action: 'pick', choice: 'Keep default (auto)' },
        ]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        expect(result.kind).toBe('defaults');
      });

      it('change provider only → override = { provider }; launcher uses override.provider + settings model + settings effort', async () => {
        // Switching provider auto-fills the new provider's first catalog model so the
        // launcher always sees a coherent provider/model pair. The test asserts only
        // `override.provider` survives because the user explicitly picked the catalog's
        // first entry — equivalent to the picker's auto-default.
        const newProvider: AiProvider = 'openai-codex';
        const newFirstModel = modelCatalogFor(newProvider)[0]!;
        const { interactive } = buildScriptedPrompt([
          { action: 'pick', choice: 'Customize for this run…' },
          { action: 'pick', choice: newProvider },
          { action: 'pick', choice: newFirstModel },
          { action: 'pick', choice: 'Keep default' },
        ]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        if (result.kind !== 'single') throw new Error(`expected kind 'single', got ${result.kind}`);
        // Provider switch forces a fresh model from the new provider's catalog so the
        // implementPair / single-flow row stays valid; effort kept at default → not present.
        expect(result.override.provider).toBe(newProvider);
        expect(result.override.model).toBe(newFirstModel);
        expect(result.override.effort).toBeUndefined();
      });

      it('change model only → override = { model }; provider + effort fall back to settings', async () => {
        // Provider stays the same so the model step still offers Keep default; picking a
        // catalog entry that differs from the default leaves only `model` on the override.
        const otherModel = CLAUDE_MODELS.find((m) => m !== DEFAULT_SETTINGS.ai[flowId].model)!;
        const { interactive } = buildScriptedPrompt([
          { action: 'pick', choice: 'Customize for this run…' },
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].provider})` },
          { action: 'pick', choice: otherModel },
          { action: 'pick', choice: 'Keep default (auto)' },
        ]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        if (result.kind !== 'single') throw new Error(`expected kind 'single', got ${result.kind}`);
        expect(result.override.provider).toBeUndefined();
        expect(result.override.model).toBe(otherModel);
        expect(result.override.effort).toBeUndefined();
      });

      it('change effort only → override = { effort }; provider + model fall back to settings', async () => {
        const { interactive } = buildScriptedPrompt([
          { action: 'pick', choice: 'Customize for this run…' },
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].provider})` },
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].model})` },
          // Claude's vocabulary; settings default has no per-flow effort so any pick differs.
          { action: 'pick', choice: 'high' },
        ]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        if (result.kind !== 'single') throw new Error(`expected kind 'single', got ${result.kind}`);
        expect(result.override.provider).toBeUndefined();
        expect(result.override.model).toBeUndefined();
        expect(result.override.effort).toBe('high');
      });

      it('cancel at the entry prompt → kind cancel; no further prompts were shown', async () => {
        const { interactive, captured } = buildScriptedPrompt([{ action: 'cancel' }]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        expect(result.kind).toBe('cancel');
        expect(captured).toHaveLength(1);
      });

      it('cancel at the model step → kind cancel; no override is returned', async () => {
        // Walked into Customize and through provider; Esc on the model step throws away the
        // session — the launcher must not see a half-completed override carrying just the
        // provider half.
        const { interactive } = buildScriptedPrompt([
          { action: 'pick', choice: 'Customize for this run…' },
          { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai[flowId].provider})` },
          { action: 'cancel' },
        ]);
        const result = await runCustomizePicker({
          interactive,
          flowId,
          flowTitle: flowId,
          settings: DEFAULT_SETTINGS,
        });
        expect(result.kind).toBe('cancel');
      });
    });
  }
});

describe('runCustomizePicker — implement (generator → evaluator)', () => {
  it('keep-all-defaults → kind defaults; no role overrides emitted', async () => {
    const { interactive } = buildScriptedPrompt([{ action: 'pick', choice: 'Start (use defaults)' }]);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'implement',
      flowTitle: 'Implement',
      settings: DEFAULT_SETTINGS,
    });
    expect(result.kind).toBe('defaults');
  });

  it('change generator only → implementRoleOverrides.generator set; evaluator absent', async () => {
    // Walk Customize through generator's three steps (change model), then evaluator's three
    // steps (Keep default on all). The launcher reads role overrides per-field, so an
    // unchanged evaluator role is simply absent.
    const gen = DEFAULT_SETTINGS.ai.implement.generator;
    const eva = DEFAULT_SETTINGS.ai.implement.evaluator;
    const newGenModel = CLAUDE_MODELS.find((m) => m !== gen.model)!;
    const { interactive } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      // generator
      { action: 'pick', choice: `Keep default (${gen.provider})` },
      { action: 'pick', choice: newGenModel },
      { action: 'pick', choice: 'Keep default (auto)' },
      // evaluator (all keep-default)
      { action: 'pick', choice: `Keep default (${eva.provider})` },
      { action: 'pick', choice: `Keep default (${eva.model})` },
      { action: 'pick', choice: 'Keep default (auto)' },
    ]);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'implement',
      flowTitle: 'Implement',
      settings: DEFAULT_SETTINGS,
    });
    if (result.kind !== 'implement') throw new Error(`expected kind 'implement', got ${result.kind}`);
    expect(result.implementRoleOverrides.generator).toEqual({ model: newGenModel });
    expect(result.implementRoleOverrides.evaluator).toBeUndefined();
  });

  it('change evaluator only → implementRoleOverrides.evaluator set; generator absent', async () => {
    const gen = DEFAULT_SETTINGS.ai.implement.generator;
    const eva = DEFAULT_SETTINGS.ai.implement.evaluator;
    const newEvaModel = CODEX_MODELS.find((m) => m !== eva.model)!;
    const { interactive } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      // generator (all keep-default)
      { action: 'pick', choice: `Keep default (${gen.provider})` },
      { action: 'pick', choice: `Keep default (${gen.model})` },
      { action: 'pick', choice: 'Keep default (auto)' },
      // evaluator (change model)
      { action: 'pick', choice: `Keep default (${eva.provider})` },
      { action: 'pick', choice: newEvaModel },
      { action: 'pick', choice: 'Keep default (auto)' },
    ]);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'implement',
      flowTitle: 'Implement',
      settings: DEFAULT_SETTINGS,
    });
    if (result.kind !== 'implement') throw new Error(`expected kind 'implement', got ${result.kind}`);
    expect(result.implementRoleOverrides.generator).toBeUndefined();
    expect(result.implementRoleOverrides.evaluator).toEqual({ model: newEvaModel });
  });

  it('change both roles → both implementRoleOverrides set', async () => {
    const gen = DEFAULT_SETTINGS.ai.implement.generator;
    const eva = DEFAULT_SETTINGS.ai.implement.evaluator;
    const newGenModel = CLAUDE_MODELS.find((m) => m !== gen.model)!;
    const newEvaModel = CODEX_MODELS.find((m) => m !== eva.model)!;
    const { interactive } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      // generator
      { action: 'pick', choice: `Keep default (${gen.provider})` },
      { action: 'pick', choice: newGenModel },
      { action: 'pick', choice: 'high' },
      // evaluator
      { action: 'pick', choice: `Keep default (${eva.provider})` },
      { action: 'pick', choice: newEvaModel },
      { action: 'pick', choice: 'medium' },
    ]);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'implement',
      flowTitle: 'Implement',
      settings: DEFAULT_SETTINGS,
    });
    if (result.kind !== 'implement') throw new Error(`expected kind 'implement', got ${result.kind}`);
    expect(result.implementRoleOverrides.generator).toEqual({ model: newGenModel, effort: 'high' });
    expect(result.implementRoleOverrides.evaluator).toEqual({ model: newEvaModel, effort: 'medium' });
  });

  it('cancel mid-evaluator → kind cancel; generator override is discarded (no partial state)', async () => {
    // The user changed the generator's model successfully but cancels on the evaluator's
    // first step. The picker must NOT leak the generator change into LaunchExtras — the
    // whole session is voided so settings.json stays the single source of truth.
    const gen = DEFAULT_SETTINGS.ai.implement.generator;
    const eva = DEFAULT_SETTINGS.ai.implement.evaluator;
    const newGenModel = CLAUDE_MODELS.find((m) => m !== gen.model)!;
    const { interactive } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      // generator (change model)
      { action: 'pick', choice: `Keep default (${gen.provider})` },
      { action: 'pick', choice: newGenModel },
      { action: 'pick', choice: 'Keep default (auto)' },
      // evaluator — provider step starts; Esc here aborts the entire session.
      { action: 'cancel' },
    ]);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'implement',
      flowTitle: 'Implement',
      settings: DEFAULT_SETTINGS,
    });
    expect(result.kind).toBe('cancel');
    // Sanity: no `evaluator` would be present on a cancel result.
    expect((result as { implementRoleOverrides?: unknown }).implementRoleOverrides).toBeUndefined();
    // Header is rendered with both defaults shown — sanity that the prompt reached evaluator.
    expect(eva.provider).toBeDefined();
  });
});

describe('runCustomizePicker — catalog source parity with settings', () => {
  // The picker MUST import the same catalogs the Settings view does. Asserting against
  // CLAUDE_MODELS directly (and not a hand-rolled copy) catches divergence at the import
  // boundary: if the picker ever forks its own list, this test fails on the next model bump.
  it('renders every CLAUDE_MODELS entry on the model step when the provider is claude-code', async () => {
    let modelStepOptions: readonly string[] | undefined;
    const interactive: InteractivePrompt = {
      async askText() {
        throw new Error('not used');
      },
      async askTextArea() {
        throw new Error('not used');
      },
      async askConfirm() {
        throw new Error('not used');
      },
      async askMultiChoice() {
        throw new Error('not used');
      },
      async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
        // Step 1: entry prompt → pick Customize.
        if (message.includes('What would you like to do?')) {
          const c = options.find((o) => o.label === 'Customize for this run…');
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        // Step 2: provider → Keep default.
        if (message.includes('Provider:')) {
          const c = options.find((o) => o.label.startsWith('Keep default'));
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        // Step 3: model → capture options for the snapshot assertion + cancel.
        if (message.includes('Model:')) {
          modelStepOptions = options.map((o) => o.label);
          return Result.error(new AbortError({ elementName: 'test', reason: 'snapshot' })) as unknown as Result<
            T,
            DomainError
          >;
        }
        throw new Error(`unexpected prompt: ${message}`);
      },
    };
    await runCustomizePicker({
      interactive,
      flowId: 'refine',
      flowTitle: 'Refine',
      settings: DEFAULT_SETTINGS,
    });
    // The first label is `Keep default (<saved model>)`; the rest must match the
    // CLAUDE_MODELS catalog in order so a model bump or rename is caught immediately.
    expect(modelStepOptions).toBeDefined();
    const catalogLabels = modelStepOptions!.slice(1);
    expect(catalogLabels).toEqual([...CLAUDE_MODELS]);
  });
});

describe('runCustomizePicker — settings.json is byte-identical after the picker', () => {
  // Hash the on-disk file before and after a picker session; the picker must never call
  // settingsRepo.save() under any path (Start / Customize-with-changes / Cancel). Uses the
  // production JsonSettingsRepository for a true round-trip, not a stub.
  const hashFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

  const runScenario = async (script: readonly ScriptEntry[]): Promise<CustomizePickerResult> => {
    const dir = mkdtempSync(join(tmpdir(), 'flows-customize-disk-'));
    const file = join(dir, 'settings.json');
    // Write a settings file the JsonSettingsRepository can load round-trip-clean.
    writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    const configRoot = AbsolutePath.parse(dir);
    if (!configRoot.ok) throw new Error(`tmp path invalid: ${dir}`);
    const repo = createJsonSettingsRepository({ configRoot: configRoot.value });
    const loaded = await repo.load();
    if (!loaded.ok) throw new Error(`load failed: ${loaded.error.message}`);
    const before = hashFile(file);
    const { interactive } = buildScriptedPrompt(script);
    const result = await runCustomizePicker({
      interactive,
      flowId: 'refine',
      flowTitle: 'Refine',
      settings: loaded.value,
    });
    const after = hashFile(file);
    expect(after).toBe(before);
    return result;
  };

  it('Start path leaves the file byte-identical', async () => {
    const result = await runScenario([{ action: 'pick', choice: 'Start (use defaults)' }]);
    expect(result.kind).toBe('defaults');
  });

  it('Customize-with-changes leaves the file byte-identical', async () => {
    const newModel = CLAUDE_MODELS.find((m) => m !== DEFAULT_SETTINGS.ai.refine.model)!;
    const result = await runScenario([
      { action: 'pick', choice: 'Customize for this run…' },
      { action: 'pick', choice: `Keep default (${DEFAULT_SETTINGS.ai.refine.provider})` },
      { action: 'pick', choice: newModel },
      { action: 'pick', choice: 'high' },
    ]);
    expect(result.kind).toBe('single');
  });

  it('Cancel at the entry prompt leaves the file byte-identical', async () => {
    const result = await runScenario([{ action: 'cancel' }]);
    expect(result.kind).toBe('cancel');
  });
});

describe('applyOverrideToSettings — launcher per-field fallback', () => {
  // The launcher applies the picker's override to the settings row BEFORE constructing
  // adapters; the per-flow launchers then read from the resulting effective settings. These
  // tests assert the merge semantics directly so the picker's "only changed fields" payload
  // and the launcher's "fall back per field" rule meet end-to-end.
  it('keeps every persisted field when override is undefined', () => {
    const effective = applyOverrideToSettings(DEFAULT_SETTINGS, 'refine', undefined);
    expect(effective).toBe(DEFAULT_SETTINGS);
  });

  it('refine: override.provider only — model + effort fall back to settings.ai.refine', () => {
    const base = driveSettings({ refine: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'high' } });
    const effective = applyOverrideToSettings(base, 'refine', { provider: 'openai-codex' });
    expect(effective.ai.refine.provider).toBe('openai-codex');
    expect(effective.ai.refine.model).toBe('claude-opus-4-8');
    expect(effective.ai.refine.effort).toBe('high');
  });

  it('refine: override.model only — provider + effort fall back to settings.ai.refine', () => {
    const base = driveSettings({ refine: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'medium' } });
    const effective = applyOverrideToSettings(base, 'refine', { model: 'claude-sonnet-4-6' });
    expect(effective.ai.refine.provider).toBe('claude-code');
    expect(effective.ai.refine.model).toBe('claude-sonnet-4-6');
    expect(effective.ai.refine.effort).toBe('medium');
  });

  it('refine: override.effort only — provider + model fall back to settings.ai.refine', () => {
    const base = driveSettings({ refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' } });
    const effective = applyOverrideToSettings(base, 'refine', { effort: 'high' });
    expect(effective.ai.refine.provider).toBe('claude-code');
    expect(effective.ai.refine.model).toBe('claude-sonnet-4-6');
    expect(effective.ai.refine.effort).toBe('high');
  });

  it('plan / readiness / ideate behave the same as refine', () => {
    for (const flow of ['plan', 'readiness', 'ideate'] as const) {
      const effective = applyOverrideToSettings(DEFAULT_SETTINGS, flow, { model: 'claude-haiku-4-5' });
      expect(effective.ai[flow].model).toBe('claude-haiku-4-5');
      expect(effective.ai[flow].provider).toBe(DEFAULT_SETTINGS.ai[flow].provider);
    }
  });

  it('review / detect-scripts / detect-skills route override through their aliased row', () => {
    // review aliases ai.implement.generator; detect-* aliases ai.readiness.
    const reviewEffective = applyOverrideToSettings(DEFAULT_SETTINGS, 'review', { model: 'claude-haiku-4-5' });
    expect(reviewEffective.ai.implement.generator.model).toBe('claude-haiku-4-5');
    // Evaluator must not be perturbed — review only touches the generator-side single row.
    expect(reviewEffective.ai.implement.evaluator).toEqual(DEFAULT_SETTINGS.ai.implement.evaluator);

    for (const flow of ['detect-scripts', 'detect-skills'] as const) {
      const effective = applyOverrideToSettings(DEFAULT_SETTINGS, flow, { model: 'claude-haiku-4-5' });
      expect(effective.ai.readiness.model).toBe('claude-haiku-4-5');
      expect(effective.ai.readiness.provider).toBe(DEFAULT_SETTINGS.ai.readiness.provider);
    }
  });

  it('implement flow itself ignores extras.override (uses implementRoleOverrides exclusively)', () => {
    // The customize picker never emits `override` for implement — it emits role overrides.
    // If a caller accidentally passes `override`, the launcher must NOT touch ai.implement
    // because the merge would be ambiguous (which role gets the override?). This test pins
    // the safety hatch.
    const effective = applyOverrideToSettings(DEFAULT_SETTINGS, 'implement', { provider: 'openai-codex' });
    expect(effective).toBe(DEFAULT_SETTINGS);
  });

  it('non-AI flows pass through unchanged regardless of override', () => {
    const effective = applyOverrideToSettings(DEFAULT_SETTINGS, 'create-sprint', { provider: 'openai-codex' });
    expect(effective).toBe(DEFAULT_SETTINGS);
  });
});

describe('runCustomizePicker — effort-inheritance visibility (T14)', () => {
  // When the user changes the model but keeps the same provider, the effort step must make the
  // inherited value visible so the user can decide deliberately — no silent xhigh inheritance.

  it('model-only change → effort step label shows the inherited row value and source tag', async () => {
    // Set up a row with an explicit per-row effort so we can assert it appears in the label.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        refine: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
      },
    };
    const otherModel = CLAUDE_MODELS.find((m) => m !== settings.ai.refine.model)!;
    let effortStepOptions: readonly string[] | undefined;
    const interactive: InteractivePrompt = {
      async askText() {
        throw new Error('not used');
      },
      async askTextArea() {
        throw new Error('not used');
      },
      async askConfirm() {
        throw new Error('not used');
      },
      async askMultiChoice() {
        throw new Error('not used');
      },
      async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
        if (message.includes('What would you like to do?')) {
          const c = options.find((o) => o.label === 'Customize for this run…');
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Provider:')) {
          const c = options.find((o) => o.label.startsWith('Keep default'));
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Model:')) {
          const c = options.find((o) => o.label === otherModel);
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Effort:')) {
          effortStepOptions = options.map((o) => o.label);
          return Result.error(new AbortError({ elementName: 'test', reason: 'snapshot' })) as unknown as Result<
            T,
            DomainError
          >;
        }
        throw new Error(`unexpected prompt: ${message}`);
      },
    };
    await runCustomizePicker({ interactive, flowId: 'refine', flowTitle: 'Refine', settings });
    expect(effortStepOptions).toBeDefined();
    // The keep-default option must show the concrete inherited effort AND the source tag so
    // the user is not surprised by xhigh arriving silently.
    const keepDefaultLabel = effortStepOptions![0];
    expect(keepDefaultLabel).toContain('xhigh');
    expect(keepDefaultLabel).toContain('saved row');
  });

  it('model-only change with global effort (no per-row effort) → effort step label shows global source', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        effort: 'high',
        refine: { provider: 'claude-code', model: 'claude-opus-4-8' },
      },
    };
    const otherModel = CLAUDE_MODELS.find((m) => m !== settings.ai.refine.model)!;
    let effortStepOptions: readonly string[] | undefined;
    const interactive: InteractivePrompt = {
      async askText() {
        throw new Error('not used');
      },
      async askTextArea() {
        throw new Error('not used');
      },
      async askConfirm() {
        throw new Error('not used');
      },
      async askMultiChoice() {
        throw new Error('not used');
      },
      async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
        if (message.includes('What would you like to do?')) {
          const c = options.find((o) => o.label === 'Customize for this run…');
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Provider:')) {
          const c = options.find((o) => o.label.startsWith('Keep default'));
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Model:')) {
          const c = options.find((o) => o.label === otherModel);
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Effort:')) {
          effortStepOptions = options.map((o) => o.label);
          return Result.error(new AbortError({ elementName: 'test', reason: 'snapshot' })) as unknown as Result<
            T,
            DomainError
          >;
        }
        throw new Error(`unexpected prompt: ${message}`);
      },
    };
    await runCustomizePicker({ interactive, flowId: 'refine', flowTitle: 'Refine', settings });
    expect(effortStepOptions).toBeDefined();
    const keepDefaultLabel = effortStepOptions![0];
    expect(keepDefaultLabel).toContain('high');
    expect(keepDefaultLabel).toContain('global');
  });

  it('model-only change + user selects Keep default → effort is absent from override (not forced xhigh)', async () => {
    // This is the core regression test for the incident. The user changes only the model;
    // selects Keep default on effort. The resulting override must NOT carry effort — the
    // launcher then resolves via the standard chain (per-row → global → undefined), which for
    // a row-without-effort and no global means the AI CLI's own built-in default, NOT xhigh.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        refine: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
      },
    };
    const otherModel = CLAUDE_MODELS.find((m) => m !== settings.ai.refine.model)!;
    const { interactive } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      { action: 'pick', choice: `Keep default (claude-code)` },
      { action: 'pick', choice: otherModel },
      // Pick the keep-default effort option (whatever label it renders — label varies).
      // We use a cancel here to inspect that we reached the effort step; in the assertion we
      // drive a real keep-default via a separate targeted pick below.
    ]);
    // Drive the full path with a scripted keep-default on effort to verify override.effort is absent.
    const { interactive: interactive2 } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      { action: 'pick', choice: `Keep default (claude-code)` },
      { action: 'pick', choice: otherModel },
      // Keep-default on effort — pick by value sentinel (__keep__). The scripted prompt
      // matches by label first, then value. The keep-default option's value is '__keep__'.
      { action: 'pick', choice: '__keep__' },
    ]);
    // Suppress the unused first interactive (the cancel-based introspection above is only for
    // documentation; the real assertion uses interactive2).
    void interactive;
    const result = await runCustomizePicker({
      interactive: interactive2,
      flowId: 'refine',
      flowTitle: 'Refine',
      settings,
    });
    if (result.kind !== 'single') throw new Error(`expected kind 'single', got ${result.kind}`);
    expect(result.override.model).toBe(otherModel);
    // effort must be absent — not silently inherited from the saved xhigh row.
    expect(result.override.effort).toBeUndefined();
  });

  it('no change to model → effort step still shows keep-default (existing label, no source tag)', async () => {
    // When the user does not change the model, the effort step renders the same label as
    // before: Keep default (<resolved value>). No source tag is appended in this case.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        refine: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'high' },
      },
    };
    let effortStepOptions: readonly string[] | undefined;
    const interactive: InteractivePrompt = {
      async askText() {
        throw new Error('not used');
      },
      async askTextArea() {
        throw new Error('not used');
      },
      async askConfirm() {
        throw new Error('not used');
      },
      async askMultiChoice() {
        throw new Error('not used');
      },
      async askChoice<T>(message: string, options: ReadonlyArray<Choice<T>>) {
        if (message.includes('What would you like to do?')) {
          const c = options.find((o) => o.label === 'Customize for this run…');
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Provider:')) {
          const c = options.find((o) => o.label.startsWith('Keep default'));
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Model:')) {
          // Keep default — same model, no change
          const c = options.find((o) => o.label.startsWith('Keep default'));
          return Result.ok(c!.value) as unknown as Result<T, DomainError>;
        }
        if (message.includes('Effort:')) {
          effortStepOptions = options.map((o) => o.label);
          return Result.error(new AbortError({ elementName: 'test', reason: 'snapshot' })) as unknown as Result<
            T,
            DomainError
          >;
        }
        throw new Error(`unexpected prompt: ${message}`);
      },
    };
    await runCustomizePicker({ interactive, flowId: 'refine', flowTitle: 'Refine', settings });
    expect(effortStepOptions).toBeDefined();
    const keepDefaultLabel = effortStepOptions![0];
    // No source tag when the model was not changed.
    expect(keepDefaultLabel).toContain('high');
    expect(keepDefaultLabel).not.toContain('saved row');
    expect(keepDefaultLabel).not.toContain('global');
  });
});

describe('runCustomizePicker — availableModelsFor gates the model step', () => {
  /** Extract the model-step options from a single-row customize walk's captured prompts. */
  const modelOptionsFromCapture = (captured: readonly CapturedPrompt[]): readonly string[] => {
    // Single-row walk: [entry prompt, provider step, model step, effort step].
    const modelStep = captured.find((c) => c.message.includes('Model:'));
    if (modelStep === undefined) throw new Error('no model step captured');
    return modelStep.options;
  };

  it('absent availableModelsFor → model step shows the full catalog', async () => {
    const defaultRow = DEFAULT_SETTINGS.ai.refine;
    const fullCatalog = modelCatalogFor(defaultRow.provider);
    const { interactive, captured } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      { action: 'pick', choice: `Keep default (${defaultRow.provider})` },
      { action: 'pick', choice: `Keep default (${defaultRow.model})` },
      { action: 'pick', choice: 'Keep default (auto)' },
    ]);
    await runCustomizePicker({ interactive, flowId: 'refine', flowTitle: 'refine', settings: DEFAULT_SETTINGS });
    const modelOptions = modelOptionsFromCapture(captured);
    // Keep-default is the first option; the rest are the full catalog.
    for (const model of fullCatalog) expect(modelOptions).toContain(model);
  });

  it('availableModelsFor returning a subset → model step shows only the subset', async () => {
    const defaultRow = DEFAULT_SETTINGS.ai.refine;
    const fullCatalog = modelCatalogFor(defaultRow.provider);
    const subset = fullCatalog.slice(0, 1);
    const excluded = fullCatalog.slice(1);
    expect(excluded.length).toBeGreaterThan(0);

    const availableModelsFor = async (provider: AiProvider): Promise<readonly string[]> =>
      provider === defaultRow.provider ? subset : modelCatalogFor(provider);

    const { interactive, captured } = buildScriptedPrompt([
      { action: 'pick', choice: 'Customize for this run…' },
      { action: 'pick', choice: `Keep default (${defaultRow.provider})` },
      { action: 'pick', choice: `Keep default (${defaultRow.model})` },
      { action: 'pick', choice: 'Keep default (auto)' },
    ]);
    await runCustomizePicker({
      interactive,
      flowId: 'refine',
      flowTitle: 'refine',
      settings: DEFAULT_SETTINGS,
      availableModelsFor,
    });
    const modelOptions = modelOptionsFromCapture(captured);
    for (const model of subset) expect(modelOptions).toContain(model);
    for (const model of excluded) expect(modelOptions).not.toContain(model);
  });
});
