/**
 * Table-driven coverage for `probeProviderAuth` — the "is this CLI authenticated?" probe used
 * by the doctor 'ai' group. Exercised directly over a stubbed `RunCommand` rather than through
 * the full doctor flow, since the interesting behavior is entirely per-provider parsing logic.
 */

import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS } from '@src/domain/entity/settings.ts';
import type { RunCommand, RunCommandResult } from '@src/integration/io/run-command.ts';
import { probeProviderAuth } from '@src/application/flows/doctor/provider-auth.ts';

const result = (partial: Partial<RunCommandResult>): RunCommandResult => ({
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  ...partial,
});

const stubRunCommand =
  (impl: (name: string, args: readonly string[]) => RunCommandResult): RunCommand =>
  async (name, args) =>
    impl(name, args);

describe('probeProviderAuth', () => {
  describe('claude-code — json-field (loggedIn)', () => {
    it('passes and reports only authMethod when loggedIn is true', async () => {
      const runCommand = stubRunCommand(() =>
        result({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', email: 'user@example.com' }) })
      );
      const probe = await probeProviderAuth('claude-code', runCommand);
      expect(probe.status).toBe('pass');
      expect(probe.detail).toContain('oauth');
      expect(probe.detail).not.toContain('example.com');
      expect(probe.id).toBe('ai-auth-claude-code');
      expect(probe.group).toBe('ai');
    });

    it('warns (not fail) when loggedIn is false', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: JSON.stringify({ loggedIn: false }) }));
      const probe = await probeProviderAuth('claude-code', runCommand);
      expect(probe.status).toBe('warn');
      expect(probe.hint).toContain('claude auth login');
    });

    it('reports unknown on garbage JSON rather than guessing', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: 'not json at all', ok: false }));
      const probe = await probeProviderAuth('claude-code', runCommand);
      expect(probe.status).toBe('unknown');
    });

    it('reports unknown when the field is present but not boolean', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: JSON.stringify({ loggedIn: 'yes' }) }));
      const probe = await probeProviderAuth('claude-code', runCommand);
      expect(probe.status).toBe('unknown');
    });
  });

  describe('openai-codex — exit-code', () => {
    it('passes on exit 0', async () => {
      const runCommand = stubRunCommand(() => result({ ok: true, code: 0 }));
      const probe = await probeProviderAuth('openai-codex', runCommand);
      expect(probe.status).toBe('pass');
      expect(probe.detail).toBe('authenticated');
    });

    it('warns on a plain non-zero exit', async () => {
      const runCommand = stubRunCommand(() => result({ ok: false, code: 1, stderr: 'Not logged in' }));
      const probe = await probeProviderAuth('openai-codex', runCommand);
      expect(probe.status).toBe('warn');
      expect(probe.detail).toContain('Not logged in');
      expect(probe.hint).toContain('codex login');
    });

    it('degrades to unknown when stderr reads like an unrecognised subcommand', async () => {
      const runCommand = stubRunCommand(() =>
        result({ ok: false, code: 1, stderr: 'error: unknown subcommand "status"' })
      );
      const probe = await probeProviderAuth('openai-codex', runCommand);
      expect(probe.status).toBe('unknown');
    });
  });

  describe('opencode — credential-count', () => {
    it('passes when at least one credential is configured', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: '2 credentials configured' }));
      const probe = await probeProviderAuth('opencode', runCommand);
      expect(probe.status).toBe('pass');
      expect(probe.detail).toContain('2');
    });

    it('reports unknown (not warn, not fail) at zero credentials — the free tier still works', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: '0 credentials configured' }));
      const probe = await probeProviderAuth('opencode', runCommand);
      expect(probe.status).toBe('unknown');
    });

    it('reports unknown when the count cannot be parsed', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: 'garbled output' }));
      const probe = await probeProviderAuth('opencode', runCommand);
      expect(probe.status).toBe('unknown');
    });

    it('strips ANSI escape codes before parsing', async () => {
      const runCommand = stubRunCommand(() => result({ stdout: '[32m1 credential[0m configured' }));
      const probe = await probeProviderAuth('opencode', runCommand);
      expect(probe.status).toBe('pass');
    });
  });

  describe('github-copilot — none', () => {
    it('reports unknown without spawning anything', async () => {
      let called = false;
      const runCommand = stubRunCommand(() => {
        called = true;
        return result({});
      });
      const probe = await probeProviderAuth('github-copilot', runCommand);
      expect(probe.status).toBe('unknown');
      expect(called).toBe(false);
      expect(probe.detail).toContain('no non-interactive auth-status verb');
    });
  });

  describe('xai-grok — none', () => {
    it('reports unknown without spawning anything', async () => {
      let called = false;
      const runCommand = stubRunCommand(() => {
        called = true;
        return result({});
      });
      const probe = await probeProviderAuth('xai-grok', runCommand);
      expect(probe.status).toBe('unknown');
      expect(called).toBe(false);
      expect(probe.detail).toContain('no non-interactive auth-status verb');
      expect(probe.id).toBe('ai-auth-xai-grok');
    });
  });

  it('never returns fail for any provider', async () => {
    const runCommand = stubRunCommand(() => result({ ok: false, code: 1, stdout: '', stderr: 'boom' }));
    for (const provider of AI_PROVIDERS) {
      const probe = await probeProviderAuth(provider, runCommand);
      expect(probe.status).not.toBe('fail');
    }
  });
});
