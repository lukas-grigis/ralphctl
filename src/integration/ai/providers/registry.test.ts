import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeAdapter } from './claude.ts';
import { copilotAdapter } from './copilot.ts';
import { getProvider } from './registry.ts';
import { providerBinary, providerDisplayName } from '@src/integration/external/provider.ts';

describe('claudeAdapter', () => {
  describe('metadata', () => {
    it('has name "claude"', () => {
      expect(claudeAdapter.name).toBe('claude');
    });

    it('has binary "claude"', () => {
      expect(claudeAdapter.binary).toBe('claude');
    });

    it('has displayName "Claude"', () => {
      expect(claudeAdapter.displayName).toBe('Claude');
    });

    it('experimental is false (Claude Code is GA)', () => {
      expect(claudeAdapter.experimental).toBe(false);
    });

    it('baseArgs includes --permission-mode and acceptEdits', () => {
      expect(claudeAdapter.baseArgs).toContain('--permission-mode');
      expect(claudeAdapter.baseArgs).toContain('acceptEdits');
    });

    it('baseArgs includes --effort xhigh (Opus 4.7 reasoning-level default)', () => {
      // Opus 4.7 introduced `xhigh` between `high` and `max`; Claude Code
      // defaults to `xhigh` for plans, and the harness matches that so
      // long-running executor/evaluator sessions get enough reasoning
      // headroom without paying the `max` premium. Older models accept the
      // flag too — the CLI maps the level down to what the model supports.
      expect(claudeAdapter.baseArgs).toContain('--effort');
      expect(claudeAdapter.baseArgs).toContain('xhigh');
    });
  });

  describe('buildInteractiveArgs', () => {
    it('returns args with -- separator before the prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('test prompt');
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--', 'test prompt']);
    });

    it('includes extra args before the prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('test prompt', ['--verbose']);
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--verbose', '--', 'test prompt']);
    });

    it('handles empty prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('');
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--', '']);
    });
  });

  describe('buildHeadlessArgs', () => {
    it('returns args with -p and --output-format json', () => {
      const args = claudeAdapter.buildHeadlessArgs();
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
    });

    it('includes base args', () => {
      const args = claudeAdapter.buildHeadlessArgs();
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
    });

    it('includes extra args', () => {
      const args = claudeAdapter.buildHeadlessArgs(['--verbose']);
      expect(args).toContain('--verbose');
    });

    it('orders args correctly', () => {
      const args = claudeAdapter.buildHeadlessArgs();
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('--output-format');
      expect(args[2]).toBe('json');
    });
  });

  describe('parseJsonOutput', () => {
    it('parses valid JSON with result and session_id', () => {
      const output = JSON.stringify({
        result: 'Task completed successfully',
        session_id: 'abc123',
      });
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Task completed successfully',
        sessionId: 'abc123',
        model: null,
      });
    });

    it('handles missing result field', () => {
      const output = JSON.stringify({
        session_id: 'abc123',
      });
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: output,
        sessionId: 'abc123',
        model: null,
      });
    });

    it('handles missing session_id field', () => {
      const output = JSON.stringify({
        result: 'Task completed',
      });
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Task completed',
        sessionId: null,
        model: null,
      });
    });

    it('falls back to raw string for non-JSON', () => {
      const output = 'Plain text output';
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Plain text output',
        sessionId: null,
        model: null,
      });
    });

    it('falls back to raw string for invalid JSON', () => {
      const output = '{ invalid json }';
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: '{ invalid json }',
        sessionId: null,
        model: null,
      });
    });

    it('handles empty string', () => {
      const parsed = claudeAdapter.parseJsonOutput('');
      expect(parsed).toEqual({
        result: '',
        sessionId: null,
        model: null,
      });
    });
  });

  describe('detectRateLimit', () => {
    it('detects "rate limit" in stderr', () => {
      const result = claudeAdapter.detectRateLimit('Error: rate limit exceeded');
      expect(result.rateLimited).toBe(true);
    });

    it('detects "rate-limit" (hyphenated)', () => {
      const result = claudeAdapter.detectRateLimit('Error: rate-limit exceeded');
      expect(result.rateLimited).toBe(true);
    });

    it('detects case-insensitive rate limit', () => {
      const result = claudeAdapter.detectRateLimit('Error: RATE LIMIT exceeded');
      expect(result.rateLimited).toBe(true);
    });

    it('detects HTTP 429 status', () => {
      const result = claudeAdapter.detectRateLimit('HTTP error 429 Too Many Requests');
      expect(result.rateLimited).toBe(true);
    });

    it('detects "too many requests"', () => {
      const result = claudeAdapter.detectRateLimit('Error: too many requests');
      expect(result.rateLimited).toBe(true);
    });

    it('detects "overloaded"', () => {
      const result = claudeAdapter.detectRateLimit('Server is overloaded');
      expect(result.rateLimited).toBe(true);
    });

    it('detects HTTP 529 status', () => {
      const result = claudeAdapter.detectRateLimit('HTTP error 529 Service Overloaded');
      expect(result.rateLimited).toBe(true);
    });

    it('returns false for normal errors', () => {
      const result = claudeAdapter.detectRateLimit('Error: connection timeout');
      expect(result.rateLimited).toBe(false);
      expect(result.retryAfterMs).toBeNull();
    });

    it('returns false for empty stderr', () => {
      const result = claudeAdapter.detectRateLimit('');
      expect(result.rateLimited).toBe(false);
    });

    it('extracts retry-after value in seconds and converts to ms', () => {
      const result = claudeAdapter.detectRateLimit('Rate limit exceeded. Retry after: 60');
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterMs).toBe(60000);
    });

    it('handles retry-after with different formats', () => {
      const result = claudeAdapter.detectRateLimit('Rate limit. retry-after: 30 seconds');
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterMs).toBe(30000);
    });

    it('returns null retryAfterMs when not specified', () => {
      const result = claudeAdapter.detectRateLimit('Rate limit exceeded');
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterMs).toBeNull();
    });
  });

  describe('getSpawnEnv', () => {
    it('returns CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD set to "1"', () => {
      const env = claudeAdapter.getSpawnEnv();
      expect(env).toEqual({
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      });
    });
  });

  describe('buildResumeArgs', () => {
    it('returns --resume with session ID as separate args', () => {
      const args = claudeAdapter.buildResumeArgs('abc123');
      expect(args).toEqual(['--resume', 'abc123']);
    });

    it('accepts valid session IDs with hyphens and underscores', () => {
      const args = claudeAdapter.buildResumeArgs('session_123-def');
      expect(args).toEqual(['--resume', 'session_123-def']);
    });

    it('throws on invalid session ID (starts with hyphen)', () => {
      expect(() => claudeAdapter.buildResumeArgs('--evil')).toThrow('Invalid session ID format');
    });

    it('throws on empty session ID', () => {
      expect(() => claudeAdapter.buildResumeArgs('')).toThrow('Invalid session ID format');
    });

    it('throws on session ID exceeding 128 characters', () => {
      expect(() => claudeAdapter.buildResumeArgs('a'.repeat(129))).toThrow('Invalid session ID format');
    });
  });
});

describe('copilotAdapter', () => {
  describe('metadata', () => {
    it('has name "copilot"', () => {
      expect(copilotAdapter.name).toBe('copilot');
    });

    it('has binary "copilot"', () => {
      expect(copilotAdapter.binary).toBe('copilot');
    });

    it('has displayName "Copilot"', () => {
      expect(copilotAdapter.displayName).toBe('Copilot');
    });

    it('experimental is true (Copilot CLI is public preview)', () => {
      expect(copilotAdapter.experimental).toBe(true);
    });

    it('baseArgs includes --allow-all-tools', () => {
      expect(copilotAdapter.baseArgs).toContain('--allow-all-tools');
    });
  });

  describe('buildInteractiveArgs', () => {
    it('returns args with -i flag before the prompt', () => {
      const args = copilotAdapter.buildInteractiveArgs('test prompt');
      expect(args).toEqual(['--allow-all-tools', '-i', 'test prompt']);
    });

    it('includes extra args before the prompt', () => {
      const args = copilotAdapter.buildInteractiveArgs('test prompt', ['--model', 'gpt-4']);
      expect(args).toEqual(['--allow-all-tools', '--model', 'gpt-4', '-i', 'test prompt']);
    });

    it('handles empty prompt', () => {
      const args = copilotAdapter.buildInteractiveArgs('');
      expect(args).toEqual(['--allow-all-tools', '-i', '']);
    });
  });

  describe('buildHeadlessArgs', () => {
    it('returns args with -p flag', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('-p');
    });

    it('includes --output-format json for structured output', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
    });

    it('includes --autopilot for autonomous headless execution', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('--autopilot');
    });

    it('includes --no-ask-user to suppress interactive prompts in headless mode', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('--no-ask-user');
    });

    it('includes --share as fallback for session ID capture', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('--share');
    });

    it('does NOT include -s (silent) — JSON output replaces silent mode', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).not.toContain('-s');
    });

    it('includes base args', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('--allow-all-tools');
    });

    it('includes extra args', () => {
      const args = copilotAdapter.buildHeadlessArgs(['--model', 'gpt-4']);
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });

    it('orders args correctly: -p, --output-format, json, --autopilot, --no-ask-user, --share first', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('--output-format');
      expect(args[2]).toBe('json');
      expect(args[3]).toBe('--autopilot');
      expect(args[4]).toBe('--no-ask-user');
      expect(args[5]).toBe('--share');
    });
  });

  describe('parseJsonOutput', () => {
    it('parses valid JSON with result and session_id from last JSONL line', () => {
      const output = JSON.stringify({
        result: 'Task completed successfully',
        session_id: 'copilot-abc123',
      });
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Task completed successfully',
        sessionId: 'copilot-abc123',
        model: null,
      });
    });

    it('extracts result from last line of multi-line JSONL output', () => {
      const line1 = JSON.stringify({ type: 'progress', message: 'Working...' });
      const line2 = JSON.stringify({ result: 'All done', session_id: 'sess-456' });
      const parsed = copilotAdapter.parseJsonOutput(`${line1}\n${line2}`);
      expect(parsed.result).toBe('All done');
      expect(parsed.sessionId).toBe('sess-456');
    });

    it('supports result_text field as alternative to result', () => {
      const output = JSON.stringify({
        result_text: 'Generated code here',
        session_id: 'xyz-789',
      });
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed.result).toBe('Generated code here');
      expect(parsed.sessionId).toBe('xyz-789');
    });

    it('prefers result over result_text when both present', () => {
      const output = JSON.stringify({
        result: 'Primary result',
        result_text: 'Secondary result',
        session_id: 'abc',
      });
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed.result).toBe('Primary result');
    });

    it('falls back to raw text for non-JSON output (graceful degradation)', () => {
      const output = 'Plain text output from CLI';
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Plain text output from CLI',
        sessionId: null,
        model: null,
      });
    });

    it('trims whitespace from non-JSON output', () => {
      const output = '  Some result with whitespace  \n';
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Some result with whitespace',
        sessionId: null,
        model: null,
      });
    });

    it('handles empty string', () => {
      const parsed = copilotAdapter.parseJsonOutput('');
      expect(parsed).toEqual({
        result: '',
        sessionId: null,
        model: null,
      });
    });

    it('returns null sessionId when JSON lacks session_id', () => {
      const output = JSON.stringify({ result: 'hello' });
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed.result).toBe('hello');
      expect(parsed.sessionId).toBeNull();
    });
  });

  describe('detectRateLimit', () => {
    it('detects "rate limit" in stderr', () => {
      const result = copilotAdapter.detectRateLimit('Error: rate limit exceeded');
      expect(result.rateLimited).toBe(true);
    });

    it('detects HTTP 429 status', () => {
      const result = copilotAdapter.detectRateLimit('HTTP error 429 Too Many Requests');
      expect(result.rateLimited).toBe(true);
    });

    it('detects GitHub API rate limit exceeded', () => {
      const result = copilotAdapter.detectRateLimit('API rate limit exceeded for user');
      expect(result.rateLimited).toBe(true);
    });

    it('detects GitHub secondary rate limit', () => {
      const result = copilotAdapter.detectRateLimit('You have exceeded a secondary rate limit');
      expect(result.rateLimited).toBe(true);
    });

    it('returns false for normal errors', () => {
      const result = copilotAdapter.detectRateLimit('Error: connection timeout');
      expect(result.rateLimited).toBe(false);
      expect(result.retryAfterMs).toBeNull();
    });

    it('extracts retry-after value', () => {
      const result = copilotAdapter.detectRateLimit('Rate limit exceeded. Retry after: 60');
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterMs).toBe(60000);
    });
  });

  describe('getSpawnEnv', () => {
    it('returns empty object', () => {
      const env = copilotAdapter.getSpawnEnv();
      expect(env).toEqual({});
    });
  });

  describe('buildResumeArgs', () => {
    it('returns --resume=sessionId as a single arg (optional-value syntax)', () => {
      const args = copilotAdapter.buildResumeArgs('abc123');
      expect(args).toEqual(['--resume=abc123']);
    });

    it('accepts valid session IDs with hyphens and underscores', () => {
      const args = copilotAdapter.buildResumeArgs('session_123-def');
      expect(args).toEqual(['--resume=session_123-def']);
    });

    it('uses equals syntax unlike Claude (which uses space-separated args)', () => {
      const claudeArgs = claudeAdapter.buildResumeArgs('abc123');
      const copilotArgs = copilotAdapter.buildResumeArgs('abc123');
      expect(claudeArgs).toHaveLength(2); // ['--resume', 'abc123']
      expect(copilotArgs).toHaveLength(1); // ['--resume=abc123']
    });

    it('throws on invalid session ID (starts with hyphen)', () => {
      expect(() => copilotAdapter.buildResumeArgs('--evil')).toThrow('Invalid session ID format');
    });

    it('throws on empty session ID', () => {
      expect(() => copilotAdapter.buildResumeArgs('')).toThrow('Invalid session ID format');
    });

    it('throws on session ID exceeding 128 characters', () => {
      expect(() => copilotAdapter.buildResumeArgs('a'.repeat(129))).toThrow('Invalid session ID format');
    });
  });

  describe('extractSessionId', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('defines extractSessionId (session capture via --share)', () => {
      expect(typeof copilotAdapter.extractSessionId).toBe('function');
    });

    it('extracts session ID from copilot-session-<ID>.md filename', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session-abc123.md'), '# Session');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBe('abc123');
    });

    it('cleans up the share file after extracting ID', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session-xyz789.md'), '# Session');
      await copilotAdapter.extractSessionId?.(dir);
      const remaining = await readdir(dir);
      expect(remaining).not.toContain('copilot-session-xyz789.md');
    });

    it('returns null when no share file exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBeNull();
    });

    it('returns null for non-existent directory', async () => {
      const id = await copilotAdapter.extractSessionId?.('/tmp/ralphctl-nonexistent-dir-xyz');
      expect(id).toBeNull();
    });

    it('rejects filenames with shell metacharacters (argument injection prevention)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session---evil-flag.md'), '# Malicious');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBeNull();
    });

    it('rejects filenames with path traversal characters', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session-..%2F..%2Fetc%2Fpasswd.md'), '# Malicious');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBeNull();
    });

    it('rejects filenames with spaces', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session-id with spaces.md'), '# Malicious');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBeNull();
    });

    it('rejects filenames exceeding 128 characters', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      const longId = 'a'.repeat(129);
      await writeFile(join(dir, `copilot-session-${longId}.md`), '# Too long');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBeNull();
    });

    it('accepts filenames with valid characters (alphanumeric, hyphens, underscores)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      await writeFile(join(dir, 'copilot-session-abc_123-DEF.md'), '# Valid');
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBe('abc_123-DEF');
    });

    it('does not delete symlinks (TOCTOU prevention)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
      const targetFile = join(dir, 'target.txt');
      await writeFile(targetFile, 'important data');
      await symlink(targetFile, join(dir, 'copilot-session-sym123.md'));
      const id = await copilotAdapter.extractSessionId?.(dir);
      // Symlink doesn't match the safe regex (sym123 is valid chars), but
      // the lstat check should prevent deletion of the symlink
      expect(id).toBe('sym123');
      // Target file must still exist — symlink was NOT followed/deleted
      expect(existsSync(targetFile)).toBe(true);
    });
  });
});

describe('getProvider (factory)', () => {
  it('returns claude adapter for "claude"', () => {
    const adapter = getProvider('claude');
    expect(adapter).toBe(claudeAdapter);
  });

  it('returns copilot adapter for "copilot"', () => {
    const adapter = getProvider('copilot');
    expect(adapter).toBe(copilotAdapter);
  });

  it('returned adapter has correct properties for claude', () => {
    const adapter = getProvider('claude');
    expect(adapter.name).toBe('claude');
    expect(adapter.binary).toBe('claude');
    expect(adapter.displayName).toBe('Claude');
  });

  it('returned adapter has correct properties for copilot', () => {
    const adapter = getProvider('copilot');
    expect(adapter.name).toBe('copilot');
    expect(adapter.binary).toBe('copilot');
    expect(adapter.displayName).toBe('Copilot');
  });
});

describe('provider utilities', () => {
  describe('providerDisplayName', () => {
    it('returns "Claude" for claude', () => {
      expect(providerDisplayName('claude')).toBe('Claude');
    });

    it('returns "Copilot" for copilot', () => {
      expect(providerDisplayName('copilot')).toBe('Copilot');
    });
  });

  describe('providerBinary', () => {
    it('returns "claude" for claude', () => {
      expect(providerBinary('claude')).toBe('claude');
    });

    it('returns "copilot" for copilot', () => {
      expect(providerBinary('copilot')).toBe('copilot');
    });
  });
});
