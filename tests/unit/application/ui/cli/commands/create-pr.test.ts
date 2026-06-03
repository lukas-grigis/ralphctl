/**
 * `ralphctl create-pr` CLI — PATH-gate regression cover.
 *
 * The AI authoring step (default-on) spawns the `createPr` row's provider CLI. The command
 * must probe PATH for that binary BEFORE running the flow, so a missing CLI fails fast with the
 * actionable "binary not found" guidance — the same gate every other AI flow uses. `--no-ai`
 * skips the gate (the template path spawns nothing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

// Mock the PATH probe so the gate's allowed-vs-blocked decision is deterministic regardless of
// what's installed on the host running the suite — mirrors the settings-command test pattern.
const detectRef = vi.hoisted(() => ({ installed: new Set<AiProvider>() }));

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

describe('ralphctl create-pr — PATH gate for the createPr provider', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
    // Default settings: createPr → claude-code. Seed claude as missing so the gate fires.
    detectRef.installed = new Set(['github-copilot', 'openai-codex']);
  });

  afterEach(async () => cli.cleanup());

  it('exits non-zero naming the missing binary and the ai.createPr.provider key when AI is on', async () => {
    const result = await runCliCaptured(cli, ['create-pr', '--sprint', 'does-not-matter']);
    // The gate fires before any sprint I/O — a missing claude CLI is surfaced first.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('CLI claude not on PATH');
    expect(result.stderr).toContain('ai.createPr.provider');
    // The message names the resolved AI flow id (camelCase `createPr`, the settings-row key).
    expect(result.stderr).toContain('flow createPr');
  });

  it('does NOT fire the PATH gate under --no-ai (template path spawns no provider)', async () => {
    detectRef.installed = new Set(); // nothing installed at all
    const result = await runCliCaptured(cli, ['create-pr', '--sprint', 'no-such-sprint', '--no-ai']);
    // The gate is skipped; the run instead fails downstream on the missing sprint — never with
    // the PATH-gate message. That proves --no-ai bypasses the probe.
    expect(result.stderr).not.toContain('not on PATH');
  });
});
