import { describe, expect, it } from 'vitest';
import {
  detectInstalledProviders,
  PROVIDER_BINARY,
  PROVIDER_INSTALL_GUIDANCE,
  primaryInstallCommand,
  renderProviderInstallGuidance,
  resolveInstallPlatform,
} from '@src/integration/system/detect-cli.ts';
import type { WhichFn } from '@src/integration/system/_engine/detect-cli.ts';

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

describe('PROVIDER_INSTALL_GUIDANCE', () => {
  it('publishes a docs URL and per-OS command list for every provider', () => {
    for (const provider of ['claude-code', 'github-copilot', 'openai-codex'] as const) {
      const g = PROVIDER_INSTALL_GUIDANCE[provider];
      expect(g.docsUrl).toMatch(/^https:\/\//);
      expect(g.commandsByPlatform.darwin.length).toBeGreaterThan(0);
      expect(g.commandsByPlatform.linux.length).toBeGreaterThan(0);
      expect(g.commandsByPlatform.win32.length).toBeGreaterThan(0);
    }
  });

  it('recommends brew first on macOS where the vendor publishes a cask', () => {
    expect(PROVIDER_INSTALL_GUIDANCE['claude-code'].commandsByPlatform.darwin[0]).toContain('brew install');
    expect(PROVIDER_INSTALL_GUIDANCE['openai-codex'].commandsByPlatform.darwin[0]).toContain('brew install');
    expect(PROVIDER_INSTALL_GUIDANCE['github-copilot'].commandsByPlatform.darwin[0]).toContain('brew install gh');
  });

  it('recommends winget first on Windows where the vendor publishes a winget package', () => {
    expect(PROVIDER_INSTALL_GUIDANCE['claude-code'].commandsByPlatform.win32[0]).toContain('winget install');
    expect(PROVIDER_INSTALL_GUIDANCE['github-copilot'].commandsByPlatform.win32[0]).toContain('winget install');
  });
});

describe('resolveInstallPlatform', () => {
  it('passes darwin and win32 through, collapses everything else to linux', () => {
    expect(resolveInstallPlatform('darwin')).toBe('darwin');
    expect(resolveInstallPlatform('win32')).toBe('win32');
    expect(resolveInstallPlatform('linux')).toBe('linux');
    expect(resolveInstallPlatform('freebsd')).toBe('linux');
    expect(resolveInstallPlatform('aix')).toBe('linux');
  });
});

describe('primaryInstallCommand', () => {
  it('returns the OS-preferred command (first entry in the per-OS list)', () => {
    expect(primaryInstallCommand('claude-code', 'darwin')).toBe('brew install --cask claude-code');
    expect(primaryInstallCommand('claude-code', 'linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(primaryInstallCommand('claude-code', 'win32')).toBe('winget install Anthropic.ClaudeCode');
    expect(primaryInstallCommand('openai-codex', 'darwin')).toBe('brew install --cask codex');
    expect(primaryInstallCommand('openai-codex', 'linux')).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(primaryInstallCommand('github-copilot', 'darwin')).toBe(
      'brew install gh && gh extension install github/gh-copilot'
    );
  });
});

describe('renderProviderInstallGuidance', () => {
  it('lists every OS-relevant option as a bullet and ends with the docs URL', () => {
    expect(renderProviderInstallGuidance('claude-code', 'darwin')).toBe(
      [
        'claude-code CLI (claude) not on PATH',
        'Install options (darwin):',
        '  • brew install --cask claude-code',
        '  • curl -fsSL https://claude.ai/install.sh | bash',
        '  • npm install -g @anthropic-ai/claude-code',
        'Docs: https://docs.claude.com/en/docs/claude-code/setup',
      ].join('\n')
    );
    expect(renderProviderInstallGuidance('openai-codex', 'linux')).toBe(
      [
        'openai-codex CLI (codex) not on PATH',
        'Install options (linux):',
        '  • curl -fsSL https://chatgpt.com/codex/install.sh | sh',
        '  • npm install -g @openai/codex',
        'Docs: https://github.com/openai/codex',
      ].join('\n')
    );
    expect(renderProviderInstallGuidance('github-copilot', 'win32')).toBe(
      [
        'github-copilot CLI (gh) not on PATH',
        'Install options (win32):',
        '  • winget install --id GitHub.cli && gh extension install github/gh-copilot',
        '  • gh extension install github/gh-copilot',
        'Docs: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli',
      ].join('\n')
    );
  });
});
