import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { CURRENT_SCHEMA_VERSION, type Settings, SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';

const SETTINGS_FILE_NAME = 'settings.json';

describe('Settings defaults + schema', () => {
  it('DEFAULT_SETTINGS passes its own schema', () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('rejects out-of-range maxTurns', () => {
    const bad = { ...DEFAULT_SETTINGS, harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 11 } };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown ai provider on a per-flow row', () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, refine: { provider: 'gemini', model: 'whatever' } },
    };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an effort value outside the row provider's native vocabulary", () => {
    // Codex does not expose `xhigh`; setting it on a codex row must fail at parse time.
    const bad = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        implement: { provider: 'openai-codex' as const, model: 'gpt-5.3-codex', effort: 'xhigh' },
      },
    };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a custom model string on a row (non-empty trimmed)', () => {
    const good = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        implement: { provider: 'claude-code' as const, model: 'my-pinned-experimental-model' },
      },
    };
    expect(SettingsSchema.safeParse(good).success).toBe(true);
  });

  it('rejects an empty/whitespace-only custom model string', () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, implement: { provider: 'claude-code' as const, model: '   ' } },
    };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects maxParallelTasks of 0', () => {
    const bad = { ...DEFAULT_SETTINGS, concurrency: { maxParallelTasks: 0 } };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('JsonSettingsRepository', () => {
  let configRoot: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-settings-'));
    const resolved = await realpath(raw);
    const parsed = AbsolutePath.parse(resolved);
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    configRoot = parsed.value;
    cleanup = async () => {
      await fs.rm(resolved, { recursive: true, force: true });
    };
  });

  afterEach(async () => cleanup());

  it('returns DEFAULT_SETTINGS when no file exists yet', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    const result = await repo.load();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a Codex profile: save then load yields the same Settings', async () => {
    const codex: Settings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ai: {
        refine: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        plan: { provider: 'openai-codex', model: 'gpt-5.4' },
        implement: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 2, plateauThreshold: 2 },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
      developer: { showEvaluatorFailureUI: false },
    };
    const repo = createJsonSettingsRepository({ configRoot });
    expect((await repo.save(codex)).ok).toBe(true);
    const loaded = await repo.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(codex);
  });

  it('round-trips a mixed-provider profile: per-flow rows persist independently', async () => {
    const custom: Settings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ai: {
        effort: 'high',
        refine: { provider: 'github-copilot', model: 'gpt-5-mini' },
        plan: { provider: 'github-copilot', model: 'gpt-5.4', effort: 'xhigh' },
        implement: { provider: 'claude-code', model: 'claude-opus-4-7', effort: 'max' },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'github-copilot', model: 'gpt-5-mini' },
      },
      harness: { maxTurns: 8, maxAttempts: 5, rateLimitRetries: 5, plateauThreshold: 3 },
      logging: { level: 'debug' },
      concurrency: { maxParallelTasks: 4 },
      ui: { notifications: { enabled: false } },
      developer: { showEvaluatorFailureUI: true },
    };
    const repo = createJsonSettingsRepository({ configRoot });
    const saved = await repo.save(custom);
    expect(saved.ok).toBe(true);

    const loaded = await repo.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(custom);
  });

  it('save refuses to write malformed Settings', async () => {
    const bad = { ...DEFAULT_SETTINGS, harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 99 } } as Settings;
    const repo = createJsonSettingsRepository({ configRoot });
    const result = await repo.save(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ParseError);

    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('load surfaces invalid JSON as StorageError(parse)', async () => {
    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    await fs.writeFile(path, '{ "broken":');

    const repo = createJsonSettingsRepository({ configRoot });
    const result = await repo.load();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StorageError);
      expect((result.error as StorageError).subCode).toBe('parse');
    }
  });

  it('load surfaces schema-violating JSON as ParseError(schema-mismatch)', async () => {
    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    await fs.writeFile(
      path,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, ai: { refine: { provider: 'unknown', model: 'x' } } })
    );

    const repo = createJsonSettingsRepository({ configRoot });
    const result = await repo.load();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ParseError);
      expect((result.error as ParseError).subCode).toBe('schema-mismatch');
    }
  });

  it('save lands valid JSON with trailing newline', async () => {
    const repo = createJsonSettingsRepository({ configRoot });
    await repo.save(DEFAULT_SETTINGS);
    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    const raw = await fs.readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual(DEFAULT_SETTINGS);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('load migrates a legacy v1 file (single ai.provider + ai.models) to v2 transparently', async () => {
    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    const legacyV1 = {
      schemaVersion: 1,
      ai: {
        provider: 'claude-code',
        models: {
          refine: 'claude-sonnet-4-6',
          plan: 'claude-opus-4-7',
          implement: 'claude-opus-4-7',
          readiness: 'claude-sonnet-4-6',
          ideate: 'claude-opus-4-7',
        },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
      developer: { showEvaluatorFailureUI: false },
    };
    await fs.writeFile(path, `${JSON.stringify(legacyV1, null, 2)}\n`);

    const repo = createJsonSettingsRepository({ configRoot });
    const loaded = await repo.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(loaded.value.ai.refine.provider).toBe('claude-code');
      expect(loaded.value.ai.implement.provider).toBe('claude-code');
    }
  });

  it('load rejects a settings file from a newer ralphctl version', async () => {
    const path = join(String(configRoot), SETTINGS_FILE_NAME);
    const future = { ...DEFAULT_SETTINGS, schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    await fs.writeFile(path, `${JSON.stringify(future, null, 2)}\n`);

    const repo = createJsonSettingsRepository({ configRoot });
    const loaded = await repo.load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toBeInstanceOf(ParseError);
      expect(loaded.error.message).toContain('newer ralphctl');
    }
  });
});
