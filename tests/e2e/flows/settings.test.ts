import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';

describe('settings use-cases — read/write through the JSON adapter', () => {
  let configRoot: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-settings-uc-'));
    const resolved = await realpath(raw);
    const parsed = AbsolutePath.parse(resolved);
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    configRoot = parsed.value;
    cleanup = async () => {
      await fs.rm(resolved, { recursive: true, force: true });
    };
  });

  afterEach(async () => cleanup());

  it('settings-show returns DEFAULT_SETTINGS on a fresh install', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    const result = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ctx.output).toEqual(DEFAULT_SETTINGS);
  });

  it('settings-set persists then settings-show reflects the change', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 7 },
      logging: { level: 'debug' },
    };

    const saved = await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next } });
    expect(saved.ok).toBe(true);

    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value.ctx.output).toEqual(next);
  });

  it("settings-set-provider switches one flow's provider and rebuilds its model from that provider's defaults", async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    // Start with a customised current record so we can verify non-AI fields are preserved.
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 7 },
      logging: { level: 'debug' },
    };
    await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next: initial } });

    const switched = await createSettingsSetProviderFlow({ settingsRepo: repo }).execute({
      input: { flow: 'implement', provider: 'github-copilot' },
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.value.ctx.output!.ai.implement).toEqual(defaultAiSettingsForProvider('github-copilot').implement);
    // Other rows untouched.
    expect(switched.value.ctx.output!.ai.refine).toEqual(DEFAULT_SETTINGS.ai.refine);
    expect(switched.value.ctx.output!.harness.maxTurns).toBe(7);
    expect(switched.value.ctx.output!.logging.level).toBe('debug');

    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    if (!reread.ok) throw new Error('expected ok');
    expect(reread.value.ctx.output!.ai.implement.provider).toBe('github-copilot');
  });

  it('settings-set rejects an invalid record without writing to disk', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    const bad = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 99 },
    } as Settings;

    const result = await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next: bad } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(ParseError);

    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value.ctx.output).toEqual(DEFAULT_SETTINGS);
  });
});
