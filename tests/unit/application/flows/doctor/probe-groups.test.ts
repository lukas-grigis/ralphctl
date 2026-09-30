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
