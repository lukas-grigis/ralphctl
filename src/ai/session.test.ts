import { describe, expect, it } from 'vitest';
import { SpawnError } from '@src/errors.ts';
import { claudeAdapter } from '@src/providers/claude.ts';

const detectRateLimit = (stderr: string) => claudeAdapter.detectRateLimit(stderr);
const parseJsonOutput = (stdout: string) => claudeAdapter.parseJsonOutput(stdout);

describe('detectRateLimit', () => {
  it('detects "rate limit" in stderr', () => {
    const result = detectRateLimit('Error: rate limit exceeded');
    expect(result.rateLimited).toBe(true);
  });

  it('detects "rate_limit" with underscore', () => {
    const result = detectRateLimit('{"type": "error", "error": {"type": "rate_limit_error"}}');
    expect(result.rateLimited).toBe(true);
  });

  it('detects HTTP 429 status code', () => {
    const result = detectRateLimit('HTTP error 429: Too Many Requests');
    expect(result.rateLimited).toBe(true);
  });

  it('detects "too many requests"', () => {
    const result = detectRateLimit('Error: too many requests, please slow down');
    expect(result.rateLimited).toBe(true);
  });

  it('detects "overloaded"', () => {
    const result = detectRateLimit('API is overloaded, try again later');
    expect(result.rateLimited).toBe(true);
  });

  it('detects HTTP 529 status code', () => {
    const result = detectRateLimit('HTTP error 529: API overloaded');
    expect(result.rateLimited).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    const result = detectRateLimit('Error: file not found');
    expect(result.rateLimited).toBe(false);
    expect(result.retryAfterMs).toBeNull();
  });

  it('parses retry-after header value', () => {
    const result = detectRateLimit('rate limit error. retry-after: 30');
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(30000); // 30 seconds in ms
  });

  it('parses retry after with different format', () => {
    const result = detectRateLimit('Rate limited. Retry after 60 seconds');
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(60000);
  });

  it('returns null retryAfterMs when no retry info', () => {
    const result = detectRateLimit('rate limit exceeded');
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBeNull();
  });

  it('handles empty stderr', () => {
    const result = detectRateLimit('');
    expect(result.rateLimited).toBe(false);
    expect(result.retryAfterMs).toBeNull();
  });

  it('does not false-positive on numbers containing 429', () => {
    // "42900" should not match 429 as a word boundary
    const result = detectRateLimit('processed 42900 records');
    expect(result.rateLimited).toBe(false);
  });
});

describe('SpawnError', () => {
  it('detects rate limit from stderr', () => {
    const err = new SpawnError('failed', 'rate limit exceeded', 1);
    expect(err.rateLimited).toBe(true);
  });

  it('stores exit code', () => {
    const err = new SpawnError('failed', 'some error', 42);
    expect(err.exitCode).toBe(42);
  });

  it('stores stderr', () => {
    const err = new SpawnError('failed', 'my stderr output', 1);
    expect(err.stderr).toBe('my stderr output');
  });

  it('parses retryAfterMs from stderr', () => {
    const err = new SpawnError('failed', 'rate limit. retry-after: 15', 1);
    expect(err.rateLimited).toBe(true);
    expect(err.retryAfterMs).toBe(15000);
  });

  it('is not rate limited for normal errors', () => {
    const err = new SpawnError('failed', 'connection refused', 1);
    expect(err.rateLimited).toBe(false);
    expect(err.retryAfterMs).toBeNull();
  });

  it('stores session ID when provided', () => {
    const err = new SpawnError('failed', 'rate limit', 1, 'session-abc-123');
    expect(err.sessionId).toBe('session-abc-123');
  });

  it('defaults sessionId to null when not provided', () => {
    const err = new SpawnError('failed', 'error', 1);
    expect(err.sessionId).toBeNull();
  });
});

describe('session ID validation', () => {
  it('rejects session IDs with shell metacharacters', () => {
    // spawnHeadlessRaw validates resumeSessionId before using it as --resume arg
    // We test the regex directly since spawning requires a real binary
    const SAFE_SESSION_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;
    expect(SAFE_SESSION_ID.test('--evil-flag')).toBe(false);
    expect(SAFE_SESSION_ID.test('$(whoami)')).toBe(false);
    expect(SAFE_SESSION_ID.test('id;rm -rf /')).toBe(false);
    expect(SAFE_SESSION_ID.test('../../../etc/passwd')).toBe(false);
    expect(SAFE_SESSION_ID.test('')).toBe(false);
    expect(SAFE_SESSION_ID.test('a'.repeat(129))).toBe(false);
  });

  it('accepts valid session IDs', () => {
    const SAFE_SESSION_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;
    expect(SAFE_SESSION_ID.test('abc123')).toBe(true);
    expect(SAFE_SESSION_ID.test('49e58e81-a626-4419-b2f5-9f8798f62953')).toBe(true);
    expect(SAFE_SESSION_ID.test('session_abc-123_DEF')).toBe(true);
    expect(SAFE_SESSION_ID.test('a'.repeat(128))).toBe(true);
  });
});

describe('parseJsonOutput', () => {
  it('extracts result and session_id from valid JSON', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello world',
      session_id: 'abc-123-def',
      duration_ms: 1000,
      total_cost_usd: 0.01,
      num_turns: 1,
    });
    const parsed = parseJsonOutput(json);
    expect(parsed.result).toBe('Hello world');
    expect(parsed.sessionId).toBe('abc-123-def');
  });

  it('falls back to raw stdout for invalid JSON', () => {
    const raw = 'Just some text output';
    const parsed = parseJsonOutput(raw);
    expect(parsed.result).toBe(raw);
    expect(parsed.sessionId).toBeNull();
  });

  it('falls back to stdout if result field is missing', () => {
    const json = JSON.stringify({ session_id: 'abc-123' });
    const parsed = parseJsonOutput(json);
    expect(parsed.result).toBe(json); // falls back since result is undefined
    expect(parsed.sessionId).toBe('abc-123');
  });

  it('returns null sessionId if session_id field is missing', () => {
    const json = JSON.stringify({ result: 'hello' });
    const parsed = parseJsonOutput(json);
    expect(parsed.result).toBe('hello');
    expect(parsed.sessionId).toBeNull();
  });

  it('handles empty string', () => {
    const parsed = parseJsonOutput('');
    expect(parsed.result).toBe('');
    expect(parsed.sessionId).toBeNull();
  });

  it('parses real AI CLI output format', () => {
    const realOutput = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1058,
      duration_api_ms: 1756,
      num_turns: 1,
      result: '<task-verified>All tests pass</task-verified>\n<task-complete>',
      stop_reason: null,
      session_id: '49e58e81-a626-4419-b2f5-9f8798f62953',
      total_cost_usd: 0.04,
    });
    const parsed = parseJsonOutput(realOutput);
    expect(parsed.result).toContain('<task-verified>');
    expect(parsed.result).toContain('<task-complete>');
    expect(parsed.sessionId).toBe('49e58e81-a626-4419-b2f5-9f8798f62953');
  });
});
