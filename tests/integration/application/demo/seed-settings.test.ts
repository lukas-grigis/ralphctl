/**
 * `ralphctl demo` must seed settings the sandbox can actually RUN, not the shipped defaults.
 * `DEFAULT_SETTINGS` deliberately splits the implement roles across two providers
 * (claude-code generator / openai-codex evaluator), so seeding it verbatim made the demo's
 * headline "ready to implement" sprint fail the launch preflight unless BOTH CLIs were
 * installed — on a command that advertises zero setup.
 *
 * These tests pin the provider-aware seeding: one detected CLI → that provider's `-only`
 * preset, several → the documented preference order, none → the claude-only fallback.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider, AiSettings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import { primaryFlowRow } from '@src/domain/entity/settings.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { seedDemoSettings } from '@src/application/demo/seed-settings.ts';

const stubDetect =
  (...installed: readonly AiProvider[]) =>
  async (): Promise<ReadonlySet<AiProvider>> =>
    new Set(installed);

const providersOf = (ai: AiSettings): ReadonlySet<AiProvider> =>
  new Set([
    ...FLOW_IDS.map((flow) => primaryFlowRow(ai, flow).provider),
    ai.implement.generator.provider,
    ai.implement.evaluator.provider,
  ]);

describe('seedDemoSettings', () => {
  let homeDir: AbsolutePath;
  let root: string;

  beforeEach(async () => {
    root = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-demo-settings-')));
    const parsed = AbsolutePath.parse(root);
    if (!parsed.ok) throw new Error('tmp dir is not absolute');
    homeDir = parsed.value;
    const paths = storagePathsFromRoot(homeDir);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    await ensureStorageRoots(paths.value);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const loadSeeded = async (): Promise<AiSettings> => {
    const paths = storagePathsFromRoot(homeDir);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    const loaded = await createJsonSettingsRepository({ configRoot: paths.value.configRoot }).load();
    if (!loaded.ok) throw new Error(`load failed: ${loaded.error.message}`);
    return loaded.value.ai;
  };

  it('routes every flow — and BOTH implement roles — to the single detected provider', async () => {
    const seeded = await seedDemoSettings({ homeDir, detect: stubDetect('github-copilot') });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.preset).toBe('copilot-only');

    const ai = await loadSeeded();
    expect(ai.implement.generator.provider).toBe('github-copilot');
    expect(ai.implement.evaluator.provider).toBe('github-copilot');
    expect([...providersOf(ai)]).toEqual(['github-copilot']);
  });

  it('picks the opencode preset when opencode is the only CLI on PATH', async () => {
    const seeded = await seedDemoSettings({ homeDir, detect: stubDetect('opencode') });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.preset).toBe('opencode-only');
    expect([...providersOf(await loadSeeded())]).toEqual(['opencode']);
  });

  it('stays single-provider when several CLIs are installed (deterministic preference order)', async () => {
    const seeded = await seedDemoSettings({
      homeDir,
      detect: stubDetect('opencode', 'github-copilot', 'openai-codex'),
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    // claude-code is absent, so the next preference wins — and it is still ONE provider, never
    // the cross-provider `mixed` matrix the first-run welcome can afford.
    expect(seeded.value.preset).toBe('codex-only');
    expect([...providersOf(await loadSeeded())]).toEqual(['openai-codex']);
  });

  it('prefers claude-code when it is among several detected CLIs', async () => {
    const seeded = await seedDemoSettings({ homeDir, detect: stubDetect('openai-codex', 'claude-code') });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.preset).toBe('claude-only');
    expect([...providersOf(await loadSeeded())]).toEqual(['claude-code']);
  });

  it('falls back to the claude-only preset when no CLI is detected — browsing needs none', async () => {
    const seeded = await seedDemoSettings({ homeDir, detect: stubDetect() });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.preset).toBe('claude-only');

    const ai = await loadSeeded();
    expect(ai.implement.generator.provider).toBe('claude-code');
    expect(ai.implement.evaluator.provider).toBe('claude-code');
  });

  it('writes a settings file the welcome flow will treat as already-seeded', async () => {
    const seeded = await seedDemoSettings({ homeDir, detect: stubDetect('claude-code') });
    expect(seeded.ok).toBe(true);
    const paths = storagePathsFromRoot(homeDir);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    const exists = await createJsonSettingsRepository({ configRoot: paths.value.configRoot }).exists();
    expect(exists.ok).toBe(true);
    if (exists.ok) expect(exists.value).toBe(true);
  });
});
