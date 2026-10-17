import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { probeAiProvidersGroup } from '@src/application/flows/doctor/probe-groups.ts';
import type { DoctorDeps } from '@src/application/flows/doctor/deps.ts';

const depsWithNothingInstalled = (): DoctorDeps =>
  ({
    settingsRepo: {
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
    },
    commandExists: async () => false,
    runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  }) as unknown as DoctorDeps;

/** An opencode-configured plan row with every CLI installed; `opencode --version` answers `version`. */
const depsWithOpenCodeAt = (version: string, calls: string[] = []): DoctorDeps =>
  ({
    settingsRepo: {
      async load() {
        return Result.ok({
          ...DEFAULT_SETTINGS,
          ai: { ...DEFAULT_SETTINGS.ai, plan: { provider: 'opencode', model: 'opencode/big-pickle' } },
        });
      },
    },
    commandExists: async () => true,
    runCommand: async (name: string, args: readonly string[]) => {
      calls.push(`${name} ${args.join(' ')}`);
      if (name === 'opencode' && args[0] === '--version')
        return { ok: true, code: 0, stdout: `${version}\n`, stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  }) as unknown as DoctorDeps;

describe('probeAiProvidersGroup — unsupported CLI major', () => {
  it('fails a configured OpenCode 2.x the launch check would refuse, and skips its auth probe', async () => {
    const calls: string[] = [];
    const probes = await probeAiProvidersGroup(depsWithOpenCodeAt('2.0.1', calls));

    const version = probes.find((p) => p.id === 'ai-opencode-version');
    expect(version?.status).toBe('fail');
    expect(version?.detail).toBe('opencode 2.0.1 is not supported — ralphctl needs opencode 1.x');
    expect(version?.hint).toMatch(/^install 1\.x with: brew install/);
    expect(probes.find((p) => p.id === 'ai-auth-opencode')).toBeUndefined();
    expect(calls.filter((c) => c.startsWith('opencode providers'))).toEqual([]);
  });

  it('adds no version row for a supported OpenCode, and still probes its auth', async () => {
    const probes = await probeAiProvidersGroup(depsWithOpenCodeAt('1.18.35'));

    expect(probes.find((p) => p.id === 'ai-opencode-version')).toBeUndefined();
    expect(probes.find((p) => p.id === 'ai-auth-opencode')).toBeDefined();
  });
});

describe('probeAiProvidersGroup — missing provider binaries', () => {
  it('warns when a provider that settings.ai references is not installed', async () => {
    const probes = await probeAiProvidersGroup(depsWithNothingInstalled());
    const configured = probes.find((p) => p.id === 'ai-claude-code');
    expect(configured?.status).toBe('warn');
    expect(configured?.hint).toContain('install');
  });

  it('passes (no nag) when an unreferenced provider is not installed', async () => {
    const probes = await probeAiProvidersGroup(depsWithNothingInstalled());
    const unused = probes.find((p) => p.id === 'ai-github-copilot');
    expect(unused?.status).toBe('pass');
    expect(unused?.detail).toBe('not installed — not used by settings');
    expect(unused?.hint).toBeUndefined();
  });
});
