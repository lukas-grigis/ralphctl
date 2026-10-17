import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AI_PROVIDERS, type AiProvider, type Settings } from '@src/domain/entity/settings.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';

// `settings set` echoes the typed value, so whatever apply-key accepts must survive save + load unchanged.
describe('settings set → save → load round trip', () => {
  let configRoot: AbsolutePath;

  beforeEach(async () => {
    const parsed = AbsolutePath.parse(await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-settings-set-'))));
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    configRoot = parsed.value;
  });

  afterEach(async () => {
    await fs.rm(String(configRoot), { recursive: true, force: true });
  });

  const onProvider = (provider: AiProvider): Settings => ({
    ...DEFAULT_SETTINGS,
    ai: defaultAiSettingsForProvider(provider),
  });

  it.each(AI_PROVIDERS.flatMap((provider) => PROVIDER_EFFORT_LEVELS[provider].map((level) => [provider, level])))(
    'persists %s effort %s exactly as typed',
    async (provider, level) => {
      const repo = createJsonSettingsRepository({ configRoot });
      for (const key of ['ai.refine.effort', 'ai.implement.generator.effort']) {
        const applied = applySettingsKey(onProvider(provider as AiProvider), key, level);
        if (!applied.ok) throw new Error(`apply-key refused ${key}=${level}: ${applied.error.message}`);
        const saved = await repo.save(applied.value);
        expect(saved.ok).toBe(true);
        const loaded = await repo.load();
        if (!loaded.ok) throw new Error(`load failed: ${loaded.error.message}`);
        const persisted =
          key === 'ai.refine.effort' ? loaded.value.ai.refine.effort : loaded.value.ai.implement.generator.effort;
        expect(persisted).toBe(level);
      }
    }
  );

  it.each([
    ['xai-grok', 'none'],
    ['xai-grok', 'minimal'],
    ['openai-codex', 'minimal'],
  ] as const)('refuses %s effort %s instead of letting save rewrite it to low', async (provider, level) => {
    const repo = createJsonSettingsRepository({ configRoot });
    const base = onProvider(provider);
    expect(applySettingsKey(base, 'ai.refine.effort', level).ok).toBe(false);
    // Bypassing apply-key shows what the refusal prevents: save runs the load-time migration.
    const bypass = { ...base, ai: { ...base.ai, refine: { ...base.ai.refine, effort: level } } };
    expect((await repo.save(bypass as unknown as Settings)).ok).toBe(true);
    const loaded = await repo.load();
    expect(loaded.ok && loaded.value.ai.refine.effort).toBe('low');
  });
});
