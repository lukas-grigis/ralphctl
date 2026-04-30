/**
 * GitHub Copilot CLI adapter.
 *
 * Maps to the `copilot` binary with `--allow-all-tools`.
 *
 * Key differences from Claude Code CLI:
 *  - Interactive mode uses `-i PROMPT` (not `-- PROMPT`).
 *  - JSON output via `--output-format json` is JSONL — one JSON object
 *    per line.
 *  - `--share` is kept as a fallback for session-id capture when JSON
 *    output lacks `session_id`.
 *  - `--autopilot` enables autonomous continuation in headless mode.
 *  - `--no-ask-user` suppresses interactive prompts in headless mode.
 *  - Status: public preview (`experimental: true`).
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ParsedOutput, ProviderAdapter, RateLimitInfo } from './types.ts';

const SESSION_ID_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;
const SESSION_FILE_REGEX = /^copilot-session-([a-zA-Z0-9_][a-zA-Z0-9_-]{0,127})\.md$/;

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /\b529\b/,
];

const RETRY_AFTER_REGEX = /retry.?after:?\s*(\d+)/i;

interface CopilotJsonShape {
  result?: string;
  result_text?: string;
  session_id?: string;
}

export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  experimental: true,
  baseArgs: ['--allow-all-tools'] as const,

  buildInteractiveArgs(prompt: string, extraArgs: readonly string[] = []): readonly string[] {
    return [...this.baseArgs, ...extraArgs, '-i', prompt];
  },

  buildHeadlessArgs(extraArgs: readonly string[] = []): readonly string[] {
    // -p: execute prompt programmatically (exits after completion).
    // --output-format json: structured JSONL output with session_id.
    // --autopilot: enable autonomous continuation without intervention.
    // --no-ask-user: disable ask_user tool so agent doesn't block on input.
    // --share: fallback for session ID capture if JSON output lacks it.
    return ['-p', '--output-format', 'json', '--autopilot', '--no-ask-user', '--share', ...this.baseArgs, ...extraArgs];
  },

  parseJsonOutput(stdout: string): ParsedOutput {
    // Copilot CLI with --output-format json produces JSONL (one JSON
    // object per line). Parse the last non-empty line as the final
    // result; fall back to raw text on parse failure.
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { result: '', sessionId: null, model: null, numTurns: null };
    }
    const lastLine = lines.at(-1) ?? '';
    let parsed: CopilotJsonShape;
    try {
      parsed = JSON.parse(lastLine) as CopilotJsonShape;
    } catch {
      // JSON parse failed — treat trimmed stdout as the result text.
      // Session id will be captured via extractSessionId fallback.
      return { result: stdout.trim(), sessionId: null, model: null, numTurns: null };
    }
    return {
      result: parsed.result ?? parsed.result_text ?? lastLine,
      sessionId: parsed.session_id ?? null,
      model: null,
      numTurns: null,
    };
  },

  buildResumeArgs(sessionId: string): readonly string[] {
    if (!SESSION_ID_REGEX.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
    // Copilot uses optional-value syntax: --resume=<id>
    return [`--resume=${sessionId}`];
  },

  async extractSessionId(cwd: AbsolutePath): Promise<string | null> {
    // --share writes ./copilot-session-<ID>.md in the cwd when the
    // process exits. Glob for the file, extract the id from the
    // filename, then clean it up. Best-effort — never throws.
    let files: readonly string[];
    try {
      files = await readdir(cwd);
    } catch {
      return null;
    }
    const shareFile = files.find((f) => SESSION_FILE_REGEX.test(f));
    if (!shareFile) return null;
    const match = SESSION_FILE_REGEX.exec(shareFile);
    if (!match?.[1]) return null;
    // Only delete regular files — refuse symlinks (TOCTOU prevention).
    const filePath = join(cwd, shareFile);
    try {
      const stat = await lstat(filePath);
      if (stat.isFile()) {
        await unlink(filePath).catch(() => {
          // Best-effort cleanup — don't fail capture on unlink failure.
        });
      }
    } catch {
      // lstat failed — extraction still succeeds, only cleanup is lost.
    }
    return match[1];
  },

  detectRateLimit(stderr: string): RateLimitInfo {
    // Copilot CLI proxies through GitHub API, which returns standard
    // HTTP 429 responses. Patterns cover both GitHub-specific language
    // ("API rate limit exceeded", "secondary rate limit") and the
    // common rate-limit vocabulary. /rate.?limit/i is intentionally
    // broad — it subsumes the more specific patterns.
    const isRateLimited = RATE_LIMIT_PATTERNS.some((p) => p.test(stderr));
    if (!isRateLimited) {
      return { rateLimited: false, retryAfterMs: null };
    }
    const retryMatch = RETRY_AFTER_REGEX.exec(stderr);
    const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;
    return { rateLimited: true, retryAfterMs };
  },

  getSpawnEnv(): Record<string, string> {
    // Copilot CLI doesn't have an equivalent to
    // CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD. The prompt instructs
    // the agent to read .github/copilot-instructions.md explicitly.
    return {};
  },
};
