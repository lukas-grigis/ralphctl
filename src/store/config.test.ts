import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnvironment } from '@src/test-utils/setup.ts';
import {
  getConfig,
  saveConfig,
  setCurrentSprint,
  getCurrentSprint,
  setAiProvider,
  getAiProvider,
  getEditor,
  setEditor,
} from './config.ts';

let env: TestEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = env.testDir;
});

afterEach(async () => {
  await env.cleanup();
  delete process.env['RALPHCTL_ROOT'];
});

describe('getConfig', () => {
  it('returns default config when no file exists', async () => {
    // Remove the config file created by createTestEnv to test the no-file path
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(env.testDir, 'config.json'), { force: true });

    const config = await getConfig();
    expect(config.currentSprint).toBeNull();
    expect(config.aiProvider).toBeNull();
  });

  it('reads an existing config file', async () => {
    const config = await getConfig();
    expect(config).toHaveProperty('currentSprint');
    expect(config).toHaveProperty('aiProvider');
  });
});

describe('saveConfig + getConfig roundtrip', () => {
  it('persists and retrieves a full config', async () => {
    const toSave = {
      currentSprint: 'sprint-abc',
      aiProvider: 'claude' as const,
      editor: 'vim',
    };
    await saveConfig(toSave);
    const loaded = await getConfig();
    expect(loaded.currentSprint).toBe('sprint-abc');
    expect(loaded.aiProvider).toBe('claude');
    expect(loaded.editor).toBe('vim');
  });
});

describe('setCurrentSprint / getCurrentSprint', () => {
  it('persists a sprint ID and reads it back', async () => {
    await setCurrentSprint('20240101-120000-my-sprint');
    const id = await getCurrentSprint();
    expect(id).toBe('20240101-120000-my-sprint');
  });

  it('clears the current sprint when set to null', async () => {
    await setCurrentSprint('some-sprint');
    await setCurrentSprint(null);
    const id = await getCurrentSprint();
    expect(id).toBeNull();
  });
});

describe('setAiProvider / getAiProvider', () => {
  it('persists claude provider and reads it back', async () => {
    await setAiProvider('claude');
    const provider = await getAiProvider();
    expect(provider).toBe('claude');
  });

  it('persists copilot provider and reads it back', async () => {
    await setAiProvider('copilot');
    const provider = await getAiProvider();
    expect(provider).toBe('copilot');
  });

  it('returns null when no provider is set', async () => {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(env.testDir, 'config.json'), { force: true });

    const provider = await getAiProvider();
    expect(provider).toBeNull();
  });
});

describe('setEditor / getEditor', () => {
  it('persists an editor command and reads it back', async () => {
    await setEditor('code --wait');
    const editor = await getEditor();
    expect(editor).toBe('code --wait');
  });

  it('returns null when no editor is set', async () => {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(env.testDir, 'config.json'), { force: true });

    const editor = await getEditor();
    expect(editor).toBeNull();
  });
});
