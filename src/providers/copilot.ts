import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from 'typescript-result';
import { IOError } from '@src/errors.ts';
import type { ParsedOutput, ProviderAdapter, RateLimitInfo } from '@src/providers/types.ts';
import { wrapAsync } from '@src/utils/result-helpers.ts';

/**
 * GitHub Copilot CLI adapter.
 *
 * Maps to the `copilot` binary with `--allow-all-tools`.
 *
 * Key differences from Claude Code CLI:
 * - Interactive mode uses `-i PROMPT` (not `-- PROMPT`)
 * - JSON output via `--output-format json` produces JSONL (one JSON object per line)
 * - `--share` kept as fallback for session ID capture when JSON output lacks session_id
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
    // --output-format json: structured JSONL output with session_id and result
    // --autopilot: enable autonomous continuation without user intervention
    // --no-ask-user: disable ask_user tool so agent doesn't block waiting for input
    // --share: fallback for session ID capture if JSON output lacks session_id
    return ['-p', '--output-format', 'json', '--autopilot', '--no-ask-user', '--share', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): ParsedOutput {
    // Copilot CLI with --output-format json produces JSONL (one JSON object per line).
    // Try to parse the last non-empty line as JSON to extract result and session_id.
    // Falls back to treating stdout as plain text if JSON parsing fails.
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { result: '', sessionId: null, model: null };
    }

    // Try parsing the last line first (most likely to contain the final result)
    const lastLine = lines.at(-1) ?? '';
    const jsonResult = Result.try(() => JSON.parse(lastLine) as unknown);
    if (jsonResult.ok) {
      const parsed = jsonResult.value as { result?: string; result_text?: string; session_id?: string };
      return {
        result: parsed.result ?? parsed.result_text ?? lastLine,
        sessionId: parsed.session_id ?? null,
        model: null,
      };
    }

    // JSON parse failed — treat raw stdout as the result text.
    // Session ID will be captured via extractSessionId (--share file fallback).
    return { result: stdout.trim(), sessionId: null, model: null };
  },

  buildResumeArgs(sessionId: string): string[] {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
    // Copilot uses optional-value syntax: --resume=<id>
    return [`--resume=${sessionId}`];
  },

  async extractSessionId(cwd: string): Promise<string | null> {
    // --share writes ./copilot-session-<ID>.md in the CWD when the process exits.
    // Glob for the file, extract the ID from the filename, then clean it up.
    const filesResult = await wrapAsync(
      () => readdir(cwd),
      (err) => new IOError(`Failed to read directory: ${cwd}`, err instanceof Error ? err : undefined)
    );
    if (!filesResult.ok) return null;
    const files = filesResult.value;
    // Session ID must start with alphanumeric/underscore (not hyphen) to prevent argument injection
    const shareFile = files.find((f) => /^copilot-session-[a-zA-Z0-9_][a-zA-Z0-9_-]*\.md$/.test(f));
    if (!shareFile) return null;
    const match = /^copilot-session-([a-zA-Z0-9_][a-zA-Z0-9_-]{0,127})\.md$/.exec(shareFile);
    if (!match?.[1]) return null;
    // Only delete regular files — refuse symlinks to prevent TOCTOU attacks
    const filePath = join(cwd, shareFile);
    const stat = await lstat(filePath).catch(() => null);
    if (stat?.isFile()) {
      await unlink(filePath).catch(() => {
        // Best-effort cleanup — don't fail session ID capture if unlink fails
      });
    }
    return match[1];
  },

  detectRateLimit(stderr: string): RateLimitInfo {
    // Copilot CLI proxies through GitHub API, which returns standard HTTP 429 responses.
    // Patterns cover both GitHub API errors and common rate-limit language.
    // Patterns cover GitHub API errors (429, "rate limit exceeded", "secondary rate limit")
    // and common rate-limit language. /rate.?limit/i is intentionally broad — it subsumes
    // more specific patterns like "API rate limit exceeded" and "secondary rate limit".
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
    // Copilot CLI doesn't have an equivalent to CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD.
    // The prompt instructions tell the agent to read .github/copilot-instructions.md explicitly.
    return {};
  },
};
