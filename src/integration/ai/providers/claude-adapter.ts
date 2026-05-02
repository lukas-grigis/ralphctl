/**
 * Claude Code CLI adapter.
 *
 * Maps to the `claude` binary. Default flags:
 *  - `--permission-mode` — split per mode:
 *      • Interactive (refine / plan / ideate / onboard) uses
 *        `acceptEdits` — auto-approves Read / Write / Edit / MultiEdit
 *        for paths inside `--add-dir` roots, still prompts for Bash /
 *        WebFetch / etc. The harness scopes the session by passing the
 *        sprint context dir as `--add-dir` (and, for plan, the selected
 *        repos), so Claude reads our handoff file and writes the
 *        artifact without prompting — but anything more dangerous still
 *        surfaces a confirmation. The user is at the keyboard.
 *      • Headless (execute / evaluate / feedback) uses
 *        `bypassPermissions` — `acceptEdits` would hang `claude -p`
 *        forever waiting on stdin for a Bash prompt. The harness layer
 *        (branch isolation, post-task check gate, dirty-tree recovery)
 *        is the right place to enforce safety here, not per-tool prompts.
 *  - `--effort xhigh` — Opus 4.7 introduced the `xhigh` effort level
 *    between `high` and `max`; Claude Code itself defaults to `xhigh` for
 *    plans, and the harness matches that so long-running executor and
 *    evaluator sessions get enough reasoning headroom without paying for
 *    `max`. Older Claude models accept the flag too — the CLI maps the
 *    level down to what the selected model supports.
 */
import type { ParsedOutput, ProviderAdapter, RateLimitInfo } from './types.ts';

const SESSION_ID_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;

/** Patterns shared by both providers — ralphctl batches them centrally so
 * a future provider can reuse the same matcher. */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /\b529\b/,
];

const RETRY_AFTER_REGEX = /retry.?after:?\s*(\d+)/i;

interface ClaudeJsonShape {
  result?: string;
  session_id?: string;
  model?: string;
  num_turns?: number;
  numTurns?: number;
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  displayName: 'Claude',
  binary: 'claude',
  // --permission-mode is per-mode, not in baseArgs. See the file header.
  baseArgs: ['--effort', 'xhigh'] as const,
  experimental: false,

  buildInteractiveArgs(prompt: string, extraArgs: readonly string[] = []): readonly string[] {
    return ['--permission-mode', 'acceptEdits', ...this.baseArgs, ...extraArgs, '--', prompt];
  },

  buildHeadlessArgs(extraArgs: readonly string[] = []): readonly string[] {
    return ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): ParsedOutput {
    let parsed: ClaudeJsonShape;
    try {
      parsed = JSON.parse(stdout) as ClaudeJsonShape;
    } catch {
      // JSON parse failed — treat raw stdout as the result text.
      return { result: stdout, sessionId: null, model: null, numTurns: null };
    }
    const rawTurns = parsed.num_turns ?? parsed.numTurns ?? null;
    return {
      result: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? null,
      model: parsed.model ?? null,
      numTurns: typeof rawTurns === 'number' && Number.isFinite(rawTurns) ? rawTurns : null,
    };
  },

  buildResumeArgs(sessionId: string): readonly string[] {
    if (!SESSION_ID_REGEX.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
    return ['--resume', sessionId];
  },

  detectRateLimit(stderr: string): RateLimitInfo {
    const isRateLimited = RATE_LIMIT_PATTERNS.some((p) => p.test(stderr));
    if (!isRateLimited) {
      return { rateLimited: false, retryAfterMs: null };
    }
    const retryMatch = RETRY_AFTER_REGEX.exec(stderr);
    const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;
    return { rateLimited: true, retryAfterMs };
  },

  getSpawnEnv(): Record<string, string> {
    return { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' };
  },
};
