import { Result } from 'typescript-result';
import type { ParsedOutput, ProviderAdapter, RateLimitInfo } from '@src/integration/ai/providers/types.ts';

/**
 * Claude Code CLI adapter.
 *
 * Maps to the `claude` binary with `--permission-mode acceptEdits`.
 */
export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  displayName: 'Claude',
  binary: 'claude',
  baseArgs: ['--permission-mode', 'acceptEdits'],

  experimental: false,

  buildInteractiveArgs(prompt: string, extraArgs: string[] = []): string[] {
    return [...this.baseArgs, ...extraArgs, '--', prompt];
  },

  buildHeadlessArgs(extraArgs: string[] = []): string[] {
    return ['-p', '--output-format', 'json', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): ParsedOutput {
    const jsonResult = Result.try(() => JSON.parse(stdout) as unknown);
    if (!jsonResult.ok) {
      // JSON parse failed — treat raw stdout as the result text
      return { result: stdout, sessionId: null, model: null };
    }
    const parsed = jsonResult.value as { result?: string; session_id?: string; model?: string };
    return {
      result: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? null,
      model: parsed.model ?? null,
    };
  },

  buildResumeArgs(sessionId: string): string[] {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
    return ['--resume', sessionId];
  },

  detectRateLimit(stderr: string): RateLimitInfo {
    const patterns = [/rate.?limit/i, /\b429\b/, /too many requests/i, /overloaded/i, /\b529\b/];
    const isRateLimited = patterns.some((p) => p.test(stderr));
    if (!isRateLimited) {
      return { rateLimited: false, retryAfterMs: null };
    }
    const retryMatch = /retry.?after:?\s*(\d+)/i.exec(stderr);
    const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;
    return { rateLimited: true, retryAfterMs };
  },

  getSpawnEnv(): Record<string, string> {
    return { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' };
  },
};
