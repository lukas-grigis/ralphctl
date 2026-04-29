import { Result } from 'typescript-result';
import type { ParsedOutput, ProviderAdapter, RateLimitInfo } from '@src/integration/ai/providers/types.ts';

/**
 * Claude Code CLI adapter.
 *
 * Maps to the `claude` binary. Default flags:
 * - `--permission-mode` — split between interactive and headless: interactive
 *   spawns use `acceptEdits` (a human is at the keyboard to answer Bash/Web
 *   prompts), unattended headless spawns use `bypassPermissions` because
 *   `acceptEdits` only auto-approves Edit tool calls and an un-allowlisted
 *   Bash call would hang `claude -p` forever waiting on stdin. The harness
 *   layer (branch isolation, post-task check gate, dirty-tree recovery) is
 *   the right place to enforce safety, not the CLI permission gate.
 * - `--effort xhigh` — Opus 4.7 introduced the `xhigh` effort level (between
 *   `high` and `max`); Claude Code itself defaults to `xhigh` for plans.
 *   Matching that default in the harness gives long-running executor and
 *   evaluator sessions enough reasoning headroom without paying for `max`.
 *   Older Claude models (Opus 4.5/4.6, Sonnet/Haiku) accept `--effort` too;
 *   the CLI maps the level down to what the selected model supports.
 */
export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  displayName: 'Claude',
  binary: 'claude',
  // --permission-mode is intentionally NOT in baseArgs — interactive vs headless
  // need different defaults (acceptEdits for interactive, bypassPermissions for
  // unattended). See `buildInteractiveArgs` and `buildHeadlessArgs` below.
  baseArgs: ['--effort', 'xhigh'],

  experimental: false,

  buildInteractiveArgs(prompt: string, extraArgs: string[] = []): string[] {
    return ['--permission-mode', 'acceptEdits', ...this.baseArgs, ...extraArgs, '--', prompt];
  },

  buildHeadlessArgs(extraArgs: string[] = []): string[] {
    return ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): ParsedOutput {
    const jsonResult = Result.try(() => JSON.parse(stdout) as unknown);
    if (!jsonResult.ok) {
      // JSON parse failed — treat raw stdout as the result text
      return { result: stdout, sessionId: null, model: null, numTurns: null };
    }
    const parsed = jsonResult.value as {
      result?: string;
      session_id?: string;
      model?: string;
      num_turns?: number;
      numTurns?: number;
    };
    const rawTurns = parsed.num_turns ?? parsed.numTurns ?? null;
    return {
      result: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? null,
      model: parsed.model ?? null,
      numTurns: typeof rawTurns === 'number' && Number.isFinite(rawTurns) ? rawTurns : null,
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
