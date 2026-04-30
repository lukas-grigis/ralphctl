import { describe, expect, it } from 'vitest';

import { claudeAdapter } from './claude-adapter.ts';

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

    it('baseArgs does not embed --permission-mode (split per mode)', () => {
      expect(claudeAdapter.baseArgs).not.toContain('--permission-mode');
      expect(claudeAdapter.baseArgs).not.toContain('acceptEdits');
      expect(claudeAdapter.baseArgs).not.toContain('bypassPermissions');
    });

    it('baseArgs includes --effort xhigh', () => {
      expect(claudeAdapter.baseArgs).toContain('--effort');
      expect(claudeAdapter.baseArgs).toContain('xhigh');
    });
  });

  describe('buildInteractiveArgs', () => {
    it('uses acceptEdits + adds prompt after --', () => {
      const args = claudeAdapter.buildInteractiveArgs('test prompt');
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--', 'test prompt']);
    });

    it('includes extra args before the prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('p', ['--verbose']);
      expect(args).toEqual(['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--verbose', '--', 'p']);
    });

    it('handles an empty prompt', () => {
      const args = claudeAdapter.buildInteractiveArgs('');
      expect(args.at(-1)).toBe('');
    });
  });

  describe('buildHeadlessArgs', () => {
    it('uses bypassPermissions and -p with json output', () => {
      const args = claudeAdapter.buildHeadlessArgs();
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('--output-format');
      expect(args[2]).toBe('json');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
      expect(args).not.toContain('acceptEdits');
    });

    it('includes base args and extras', () => {
      const args = claudeAdapter.buildHeadlessArgs(['--verbose']);
      expect(args).toContain('--effort');
      expect(args).toContain('xhigh');
      expect(args).toContain('--verbose');
    });

    // Ported from afe771f9~1:src/integration/ai/providers/claude.ts — exact arg order
    it('produces args in exact order: -p, --output-format, json, --permission-mode, bypassPermissions, --effort, xhigh, ...extras', () => {
      const args = claudeAdapter.buildHeadlessArgs(['--extra']);
      expect(args).toEqual([
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--effort',
        'xhigh',
        '--extra',
      ]);
    });

    it('extras are appended after --effort xhigh when extraArgs is empty', () => {
      const args = claudeAdapter.buildHeadlessArgs();
      expect(args).toEqual([
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--effort',
        'xhigh',
      ]);
    });
  });

  describe('parseJsonOutput', () => {
    it('parses result + session_id + model + num_turns', () => {
      const stdout = JSON.stringify({
        result: 'done',
        session_id: 'abc123',
        model: 'opus',
        num_turns: 4,
      });
      const parsed = claudeAdapter.parseJsonOutput(stdout);
      expect(parsed).toEqual({
        result: 'done',
        sessionId: 'abc123',
        model: 'opus',
        numTurns: 4,
      });
    });

    it('accepts numTurns (camelCase) fallback', () => {
      const stdout = JSON.stringify({ result: 'done', numTurns: 7 });
      expect(claudeAdapter.parseJsonOutput(stdout).numTurns).toBe(7);
    });

    it('coerces non-finite num_turns to null', () => {
      const stdout = JSON.stringify({ result: 'done', num_turns: 'lots' });
      expect(claudeAdapter.parseJsonOutput(stdout).numTurns).toBeNull();
    });

    it('falls back to raw stdout on invalid JSON', () => {
      const parsed = claudeAdapter.parseJsonOutput('{not json');
      expect(parsed).toEqual({
        result: '{not json',
        sessionId: null,
        model: null,
        numTurns: null,
      });
    });

    it('falls back when result is missing', () => {
      const stdout = JSON.stringify({ session_id: 'abc' });
      const parsed = claudeAdapter.parseJsonOutput(stdout);
      expect(parsed.result).toBe(stdout);
      expect(parsed.sessionId).toBe('abc');
    });

    it('handles empty input', () => {
      expect(claudeAdapter.parseJsonOutput('')).toEqual({
        result: '',
        sessionId: null,
        model: null,
        numTurns: null,
      });
    });
  });

  describe('detectRateLimit', () => {
    it.each([
      ['rate limit exceeded'],
      ['rate-limit'],
      ['RATE LIMIT'],
      ['HTTP 429 Too Many Requests'],
      ['too many requests'],
      ['overloaded'],
      ['HTTP 529 Overloaded'],
    ])('matches %s', (stderr) => {
      expect(claudeAdapter.detectRateLimit(stderr).rateLimited).toBe(true);
    });

    it('returns false for normal errors', () => {
      const r = claudeAdapter.detectRateLimit('connection refused');
      expect(r.rateLimited).toBe(false);
      expect(r.retryAfterMs).toBeNull();
    });

    it('extracts retry-after seconds and converts to ms', () => {
      const r = claudeAdapter.detectRateLimit('rate limit. retry-after: 30');
      expect(r.retryAfterMs).toBe(30_000);
    });

    it('returns null retryAfterMs when not specified', () => {
      const r = claudeAdapter.detectRateLimit('rate limit exceeded');
      expect(r.retryAfterMs).toBeNull();
    });

    it('does not match 429 inside larger numbers (word boundary)', () => {
      expect(claudeAdapter.detectRateLimit('processed 42900 records').rateLimited).toBe(false);
    });

    // Ported from afe771f9~1:src/integration/ai/providers/claude.ts — legacy coverage
    it('returns false for empty stderr', () => {
      const r = claudeAdapter.detectRateLimit('');
      expect(r.rateLimited).toBe(false);
      expect(r.retryAfterMs).toBeNull();
    });

    it('returns false for generic 5xx without rate-limit keywords', () => {
      const r = claudeAdapter.detectRateLimit('HTTP 500 Internal Server Error');
      expect(r.rateLimited).toBe(false);
    });

    it('parses retry-after:120 without space around colon', () => {
      const r = claudeAdapter.detectRateLimit('rate limit hit. retry-after:120');
      expect(r.retryAfterMs).toBe(120_000);
    });

    it('matches Service Overloaded (529) pattern', () => {
      expect(claudeAdapter.detectRateLimit('Service Overloaded (529)').rateLimited).toBe(true);
    });
  });

  describe('buildResumeArgs', () => {
    it('returns space-separated --resume + sessionId', () => {
      expect(claudeAdapter.buildResumeArgs('abc123')).toEqual(['--resume', 'abc123']);
    });

    it('accepts hyphens and underscores after the first character', () => {
      expect(claudeAdapter.buildResumeArgs('s_1-2-3')).toEqual(['--resume', 's_1-2-3']);
    });

    it('throws on session ids that begin with a hyphen', () => {
      expect(() => claudeAdapter.buildResumeArgs('--evil')).toThrow(/Invalid session ID/);
    });

    it('throws on empty session ids', () => {
      expect(() => claudeAdapter.buildResumeArgs('')).toThrow(/Invalid session ID/);
    });

    it('throws on session ids longer than 128 chars', () => {
      expect(() => claudeAdapter.buildResumeArgs('a'.repeat(129))).toThrow(/Invalid session ID/);
    });

    // Ported from afe771f9~1:src/integration/ai/providers/claude.ts
    it('throws on session ids containing shell metacharacters', () => {
      expect(() => claudeAdapter.buildResumeArgs('abc;rm -rf')).toThrow(/Invalid session ID/);
    });

    it('throws on session ids containing spaces', () => {
      expect(() => claudeAdapter.buildResumeArgs('session id')).toThrow(/Invalid session ID/);
    });
  });

  describe('getSpawnEnv', () => {
    it('exposes CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1', () => {
      expect(claudeAdapter.getSpawnEnv()).toEqual({
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      });
    });
  });
});
