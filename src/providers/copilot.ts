import type { ProviderAdapter, RateLimitInfo } from '@src/providers/types.ts';

/**
 * GitHub Copilot CLI adapter.
 *
 * Maps to the `copilot` binary with `--allow-all-tools`.
 *
 * Key differences from Claude Code CLI:
 * - Interactive mode uses `-i PROMPT` (not `-- PROMPT`)
 * - No `--output-format json`; uses `-s` (silent) for clean stdout
 * - Headless output is plain text, not JSON — session_id is unavailable
 */
export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  baseArgs: ['--allow-all-tools'],

  buildInteractiveArgs(prompt: string, extraArgs: string[] = []): string[] {
    return [...this.baseArgs, ...extraArgs, '-i', prompt];
  },

  buildHeadlessArgs(extraArgs: string[] = []): string[] {
    // -p: execute prompt programmatically (exits after completion)
    // -s: silent — output only the agent response (no usage stats)
    return ['-p', '-s', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): { result: string; sessionId: string | null } {
    // Copilot CLI outputs plain text (no JSON mode), so return as-is.
    // Session ID is not available from headless output.
    return { result: stdout.trim(), sessionId: null };
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
    return {};
  },
};
