import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderAdapter, RateLimitInfo } from '@src/providers/types.ts';

/**
 * GitHub Copilot CLI adapter.
 *
 * Maps to the `copilot` binary with `--allow-all-tools`.
 *
 * Key differences from Claude Code CLI:
 * - Interactive mode uses `-i PROMPT` (not `-- PROMPT`)
 * - No `--output-format json`; uses `-s` (silent) for clean stdout
 * - Headless output is plain text — session_id is not in stdout, but can be
 *   captured via `--share` which writes `./copilot-session-<ID>.md` on exit
 * - Requires `--autopilot` for autonomous continuation in headless mode
 * - Requires `--no-ask-user` to suppress interactive prompts in headless mode
 * - Status: public preview (experimental: true)
 */
export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  experimental: true,
  baseArgs: ['--allow-all-tools'],

  buildInteractiveArgs(prompt: string, extraArgs: string[] = []): string[] {
    return [...this.baseArgs, ...extraArgs, '-i', prompt];
  },

  buildHeadlessArgs(extraArgs: string[] = []): string[] {
    // -p: execute prompt programmatically (exits after completion)
    // -s: silent — output only the agent response (no usage stats)
    // --autopilot: enable autonomous continuation without user intervention
    // --no-ask-user: disable ask_user tool so agent doesn't block waiting for input
    // --share: write session to ./copilot-session-<ID>.md so we can capture the session ID
    return ['-p', '-s', '--autopilot', '--no-ask-user', '--share', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): { result: string; sessionId: string | null } {
    // Copilot CLI outputs plain text (no JSON mode), so return as-is.
    // Session ID is captured separately via extractSessionId (--share output file).
    return { result: stdout.trim(), sessionId: null };
  },

  async extractSessionId(cwd: string): Promise<string | null> {
    // --share writes ./copilot-session-<ID>.md in the CWD when the process exits.
    // Glob for the file, extract the ID from the filename, then clean it up.
    try {
      const files = await readdir(cwd);
      const shareFile = files.find((f) => /^copilot-session-.+\.md$/.test(f));
      if (!shareFile) return null;
      const match = /^copilot-session-(.+)\.md$/.exec(shareFile);
      if (!match?.[1]) return null;
      await unlink(join(cwd, shareFile)).catch(() => {
        // Best-effort cleanup — don't fail session ID capture if unlink fails
      });
      return match[1];
    } catch {
      return null;
    }
  },

  detectRateLimit(stderr: string): RateLimitInfo {
    // TODO: These patterns are borrowed from the Claude adapter and have not been validated
    // against real Copilot CLI rate-limit error messages. If Copilot CLI produces different
    // error output (e.g. GitHub API 429 responses), add patterns here based on real observations.
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
