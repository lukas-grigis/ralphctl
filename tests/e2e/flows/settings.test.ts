import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';

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

    const switched = await createSettingsSetProviderFlow({
      settingsRepo: repo,
      // Stub the PATH probe so the test passes regardless of what's installed on the host —
      // the gate is exercised by the dedicated "rejects unavailable provider" test below.
      detectInstalledProviders: async () => new Set(['claude-code', 'github-copilot', 'openai-codex'] as const),
    }).execute({
      input: { flow: 'implement', provider: 'github-copilot', role: 'generator' },
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    // Only the named role is rebuilt; the other role stays at the prior default.
    expect(switched.value.ctx.output!.ai.implement.generator).toEqual(
      defaultAiSettingsForProvider('github-copilot').implement.generator
    );
    expect(switched.value.ctx.output!.ai.implement.evaluator).toEqual(DEFAULT_SETTINGS.ai.implement.evaluator);
    // Other rows untouched.
    expect(switched.value.ctx.output!.ai.refine).toEqual(DEFAULT_SETTINGS.ai.refine);
    expect(switched.value.ctx.output!.harness.maxTurns).toBe(7);
    expect(switched.value.ctx.output!.logging.level).toBe('debug');

    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    if (!reread.ok) throw new Error('expected ok');
    expect(reread.value.ctx.output!.ai.implement.generator.provider).toBe('github-copilot');
  });

  it('settings-apply-preset stamps a preset matrix and preserves non-AI sections', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    // Customise non-AI sections so we can verify they survive the preset stamp.
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 9 },
      logging: { level: 'debug' },
      concurrency: { maxParallelTasks: 4 },
    };
    await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next: initial } });

    const applied = await createSettingsApplyPresetFlow({
      settingsRepo: repo,
      // Stub the PATH probe so the test does not depend on whatever's installed on the host.
      detectInstalledProviders: async () => new Set(['claude-code', 'github-copilot', 'openai-codex'] as const),
    }).execute({
      input: { preset: 'codex-only' },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const out = applied.value.ctx.output!.settings;
    for (const flow of ['refine', 'plan', 'readiness', 'ideate'] as const) {
      expect(out.ai[flow].provider).toBe('openai-codex');
    }
    expect(out.ai.implement.generator.provider).toBe('openai-codex');
    expect(out.ai.implement.evaluator.provider).toBe('openai-codex');
    expect(out.ai.effort).toBe('high');
    expect(out.harness.maxTurns).toBe(9);
    expect(out.logging.level).toBe('debug');
    expect(out.concurrency.maxParallelTasks).toBe(4);
    expect(applied.value.ctx.output!.warnings).toEqual([]);

    // Re-read from disk to confirm the change persisted.
    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    if (!reread.ok) throw new Error('expected ok');
    for (const flow of ['refine', 'plan', 'readiness', 'ideate'] as const) {
      expect(reread.value.ctx.output!.ai[flow].provider).toBe('openai-codex');
    }
    expect(reread.value.ctx.output!.ai.implement.generator.provider).toBe('openai-codex');
    expect(reread.value.ctx.output!.ai.implement.evaluator.provider).toBe('openai-codex');
  });

  it('settings-set-provider rejects an unavailable provider with a ValidationError naming the settings key and install command', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    // Persist a known starting state so we can confirm the disk record is untouched after
    // the gate fires.
    await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next: DEFAULT_SETTINGS } });

    const blocked = await createSettingsSetProviderFlow({
      settingsRepo: repo,
      // Codex is the requested provider; the stub deliberately excludes it.
      detectInstalledProviders: async () => new Set(['claude-code', 'github-copilot'] as const),
    }).execute({
      input: { flow: 'refine', provider: 'openai-codex' },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const err = blocked.error.error;
    expect(err).toBeInstanceOf(ValidationError);
    if (!(err instanceof ValidationError)) return;
    expect(err.field).toBe('ai.refine.provider');
    expect(err.value).toBe('openai-codex');
    expect(err.message).toContain('openai-codex');
    expect(err.message).toContain('codex');
    expect(err.message).toContain('ai.refine.provider');
    expect(err.hint).toContain('npm install -g @openai/codex');

    // Disk state matches the pre-attempt record — the gate fires BEFORE persistence.
    const reread = await createSettingsShowFlow({ settingsRepo: repo }).execute({ input: undefined });
    if (!reread.ok) throw new Error('expected ok');
    expect(reread.value.ctx.output!.ai.refine.provider).toBe(DEFAULT_SETTINGS.ai.refine.provider);
  });

  it('settings-set-provider names the implement role in the ValidationError settings key', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    await createSettingsSetFlow({ settingsRepo: repo }).execute({ input: { next: DEFAULT_SETTINGS } });

    const blocked = await createSettingsSetProviderFlow({
      settingsRepo: repo,
      detectInstalledProviders: async () => new Set(['claude-code'] as const),
    }).execute({
      input: { flow: 'implement', provider: 'github-copilot', role: 'evaluator' },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const err = blocked.error.error;
    expect(err).toBeInstanceOf(ValidationError);
    if (!(err instanceof ValidationError)) return;
    expect(err.field).toBe('ai.implement.evaluator.provider');
    expect(err.message).toContain('ai.implement.evaluator.provider');
    expect(err.hint).toContain('gh extension install github/gh-copilot');
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
