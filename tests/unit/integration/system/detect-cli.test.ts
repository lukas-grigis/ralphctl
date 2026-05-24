import { describe, expect, it } from 'vitest';
import { detectInstalledProviders, PROVIDER_BINARY, type WhichFn } from '@src/integration/system/detect-cli.ts';

const whichFor =
  (present: ReadonlySet<string>): WhichFn =>
  async (binary) =>
    present.has(binary);

describe('detectInstalledProviders', () => {
  it('maps providers to claude / gh / codex binaries', () => {
    expect(PROVIDER_BINARY).toEqual({
      'claude-code': 'claude',
      'github-copilot': 'gh',
      'openai-codex': 'codex',
    });
  });

  it('returns the providers whose binary the `which` seam reports present', async () => {
    const installed = await detectInstalledProviders({ which: whichFor(new Set(['claude', 'codex'])) });
    expect([...installed].sort()).toEqual(['claude-code', 'openai-codex']);
  });

  it('returns an empty set when nothing is on PATH', async () => {
    const installed = await detectInstalledProviders({ which: whichFor(new Set()) });
    expect(installed.size).toBe(0);
  });

  it('returns every provider when every binary is on PATH', async () => {
    const installed = await detectInstalledProviders({
      which: whichFor(new Set(['claude', 'gh', 'codex'])),
    });
    expect([...installed].sort()).toEqual(['claude-code', 'github-copilot', 'openai-codex']);
  });

  it('probes each binary exactly once per call', async () => {
    const calls: string[] = [];
    const which: WhichFn = async (binary) => {
      calls.push(binary);
      return false;
    };
    await detectInstalledProviders({ which });
    expect(calls.sort()).toEqual(['claude', 'codex', 'gh']);
  });
});
