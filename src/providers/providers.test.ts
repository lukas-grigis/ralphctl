import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude.ts';
import { copilotAdapter } from './copilot.ts';
import { getProvider } from './index.ts';
import { providerBinary, providerDisplayName } from '@src/utils/provider.ts';

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

    it('baseArgs includes --permission-mode and acceptEdits', () => {
      expect(claudeAdapter.baseArgs).toContain('--permission-mode');
      expect(claudeAdapter.baseArgs).toContain('acceptEdits');
    });
  });

  describe('buildInteractiveArgs', () => {
    it('returns args with -- separator before the prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('test prompt');
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--', 'test prompt']);
    });

    it('includes extra args before the prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('test prompt', ['--verbose']);
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--verbose', '--', 'test prompt']);
    });

    it('handles empty prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('');
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--', '']);
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
      });
    });

    it('falls back to raw string for non-JSON', () => {
      const output = 'Plain text output';
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Plain text output',
        sessionId: null,
      });
    });

    it('falls back to raw string for invalid JSON', () => {
      const output = '{ invalid json }';
      const parsed = claudeAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: '{ invalid json }',
        sessionId: null,
      });
    });

    it('handles empty string', () => {
      const parsed = claudeAdapter.parseJsonOutput('');
      expect(parsed).toEqual({
        result: '',
        sessionId: null,
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
    it('returns args with -p and -s (silent) flags', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).toContain('-p');
      expect(args).toContain('-s');
    });

    it('does NOT include --output-format json (not supported by Copilot CLI)', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('json');
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

    it('orders args correctly: -p, -s, base args, extra args', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('-s');
    });
  });

  describe('parseJsonOutput', () => {
    it('returns plain text as-is with null sessionId (Copilot has no JSON mode)', () => {
      const output = 'Task completed successfully';
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Task completed successfully',
        sessionId: null,
      });
    });

    it('trims whitespace from output', () => {
      const output = '  Some result with whitespace  \n';
      const parsed = copilotAdapter.parseJsonOutput(output);
      expect(parsed).toEqual({
        result: 'Some result with whitespace',
        sessionId: null,
      });
    });

    it('handles empty string', () => {
      const parsed = copilotAdapter.parseJsonOutput('');
      expect(parsed).toEqual({
        result: '',
        sessionId: null,
      });
    });

    it('does not attempt JSON parsing — returns raw even for valid JSON strings', () => {
      const jsonStr = JSON.stringify({ result: 'hello', session_id: 'abc' });
      const parsed = copilotAdapter.parseJsonOutput(jsonStr);
      // Copilot adapter treats ALL output as plain text
      expect(parsed.sessionId).toBeNull();
      expect(parsed.result).toBe(jsonStr.trim());
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
