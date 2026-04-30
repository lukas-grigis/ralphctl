import { mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { copilotAdapter } from './copilot-adapter.ts';

async function tmpAbs(): Promise<AbsolutePath> {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-copilot-'));
  return AbsolutePath.trustString(dir);
}

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
    it('uses -i PROMPT (not --)', () => {
      const args = copilotAdapter.buildInteractiveArgs('test prompt');
      expect(args).toEqual(['--allow-all-tools', '-i', 'test prompt']);
    });

    it('places extras between baseArgs and -i', () => {
      const args = copilotAdapter.buildInteractiveArgs('p', ['--model', 'gpt-4']);
      expect(args).toEqual(['--allow-all-tools', '--model', 'gpt-4', '-i', 'p']);
    });
  });

  describe('buildHeadlessArgs', () => {
    it('orders -p, --output-format json, --autopilot, --no-ask-user, --share', () => {
      const args = copilotAdapter.buildHeadlessArgs();
      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('--output-format');
      expect(args[2]).toBe('json');
      expect(args[3]).toBe('--autopilot');
      expect(args[4]).toBe('--no-ask-user');
      expect(args[5]).toBe('--share');
    });

    it('appends baseArgs and extras', () => {
      const args = copilotAdapter.buildHeadlessArgs(['--model', 'gpt-4']);
      expect(args).toContain('--allow-all-tools');
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });
  });

  describe('parseJsonOutput', () => {
    it('parses single-line JSON', () => {
      const out = JSON.stringify({ result: 'done', session_id: 's1' });
      expect(copilotAdapter.parseJsonOutput(out)).toEqual({
        result: 'done',
        sessionId: 's1',
        model: null,
        numTurns: null,
      });
    });

    it('reads the LAST line of JSONL', () => {
      const a = JSON.stringify({ type: 'progress' });
      const b = JSON.stringify({ result: 'final', session_id: 's2' });
      const parsed = copilotAdapter.parseJsonOutput(`${a}\n${b}`);
      expect(parsed.result).toBe('final');
      expect(parsed.sessionId).toBe('s2');
    });

    it('falls back to result_text when result is missing', () => {
      const out = JSON.stringify({ result_text: 'r', session_id: 'x' });
      expect(copilotAdapter.parseJsonOutput(out).result).toBe('r');
    });

    it('prefers result over result_text when both present', () => {
      const out = JSON.stringify({ result: 'a', result_text: 'b' });
      expect(copilotAdapter.parseJsonOutput(out).result).toBe('a');
    });

    it('falls back to trimmed text on invalid JSON', () => {
      const parsed = copilotAdapter.parseJsonOutput('  not json  \n');
      expect(parsed.result).toBe('not json');
      expect(parsed.sessionId).toBeNull();
    });

    it('handles empty input', () => {
      expect(copilotAdapter.parseJsonOutput('')).toEqual({
        result: '',
        sessionId: null,
        model: null,
        numTurns: null,
      });
    });
  });

  describe('buildResumeArgs', () => {
    it('uses --resume=<id> (single arg)', () => {
      expect(copilotAdapter.buildResumeArgs('abc123')).toEqual(['--resume=abc123']);
    });

    it('rejects ids starting with a hyphen', () => {
      expect(() => copilotAdapter.buildResumeArgs('--evil')).toThrow(/Invalid session ID/);
    });

    it('rejects empty session ids', () => {
      expect(() => copilotAdapter.buildResumeArgs('')).toThrow(/Invalid session ID/);
    });

    it('rejects ids longer than 128 chars', () => {
      expect(() => copilotAdapter.buildResumeArgs('a'.repeat(200))).toThrow(/Invalid session ID/);
    });
  });

  describe('extractSessionId', () => {
    it('returns null when no share file exists', async () => {
      const dir = await tmpAbs();
      expect(await copilotAdapter.extractSessionId?.(dir)).toBeNull();
    });

    it('returns null when the directory does not exist', async () => {
      const dir = AbsolutePath.trustString('/tmp/ralphctl-nonexistent-xyz-dir-9999');
      expect(await copilotAdapter.extractSessionId?.(dir)).toBeNull();
    });

    it('extracts the id from copilot-session-<id>.md', async () => {
      const dir = await tmpAbs();
      await writeFile(join(dir, 'copilot-session-abc123.md'), 'session');
      expect(await copilotAdapter.extractSessionId?.(dir)).toBe('abc123');
    });

    it('cleans up the share file after extracting', async () => {
      const dir = await tmpAbs();
      const file = join(dir, 'copilot-session-xyz789.md');
      await writeFile(file, 'session');
      await copilotAdapter.extractSessionId?.(dir);
      expect(existsSync(file)).toBe(false);
      const remaining = await readdir(dir);
      expect(remaining).not.toContain('copilot-session-xyz789.md');
    });

    it('rejects file names that begin with a hyphen', async () => {
      const dir = await tmpAbs();
      await writeFile(join(dir, 'copilot-session---evil-flag.md'), 'm');
      expect(await copilotAdapter.extractSessionId?.(dir)).toBeNull();
    });

    it('does not delete symlinks (TOCTOU prevention)', async () => {
      const dir = await tmpAbs();
      const target = join(dir, 'target.txt');
      await writeFile(target, 'important');
      await symlink(target, join(dir, 'copilot-session-sym123.md'));
      const id = await copilotAdapter.extractSessionId?.(dir);
      expect(id).toBe('sym123');
      // Target survived: symlink was matched by regex but lstat refused unlink.
      expect(existsSync(target)).toBe(true);
    });
  });

  describe('detectRateLimit', () => {
    it.each([
      ['rate limit exceeded'],
      ['HTTP 429 Too Many Requests'],
      ['API rate limit exceeded for user'],
      ['You have exceeded a secondary rate limit'],
    ])('matches %s', (stderr) => {
      expect(copilotAdapter.detectRateLimit(stderr).rateLimited).toBe(true);
    });

    it('extracts retry-after value', () => {
      const r = copilotAdapter.detectRateLimit('Rate limit. Retry after: 60');
      expect(r.retryAfterMs).toBe(60_000);
    });

    it('returns false for normal errors', () => {
      const r = copilotAdapter.detectRateLimit('connection refused');
      expect(r.rateLimited).toBe(false);
      expect(r.retryAfterMs).toBeNull();
    });

    // Ported from afe771f9~1:src/integration/ai/providers/copilot.ts — legacy coverage
    it('returns false for empty stderr', () => {
      const r = copilotAdapter.detectRateLimit('');
      expect(r.rateLimited).toBe(false);
      expect(r.retryAfterMs).toBeNull();
    });

    it('matches overloaded pattern', () => {
      expect(copilotAdapter.detectRateLimit('overloaded').rateLimited).toBe(true);
    });

    it('matches 529 Service Overloaded pattern', () => {
      expect(copilotAdapter.detectRateLimit('Service Overloaded (529)').rateLimited).toBe(true);
    });

    it('parses retry-after:120 without space around colon', () => {
      const r = copilotAdapter.detectRateLimit('rate limit hit. retry-after:120');
      expect(r.retryAfterMs).toBe(120_000);
    });

    it('returns null retryAfterMs when rate-limited without retry-after directive', () => {
      const r = copilotAdapter.detectRateLimit('rate limit exceeded');
      expect(r.rateLimited).toBe(true);
      expect(r.retryAfterMs).toBeNull();
    });
  });

  describe('getSpawnEnv', () => {
    it('returns an empty record', () => {
      expect(copilotAdapter.getSpawnEnv()).toEqual({});
    });
  });
});
