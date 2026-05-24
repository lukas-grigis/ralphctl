// Verified against `claude --help` / `claude config get` (Claude Code v2.x).
// Docs: https://docs.claude.com/en/docs/claude-code/cli-reference

/**
 * Models supported by the Claude Code CLI adapter. Domain-owned: persisted Settings reference
 * these identifiers; adapters consume them when invoking the CLI subprocess. The adapter still
 * validates `AiSession.model` against this set at the boundary so a stale persisted value or
 * mistyped CLI input is caught with `InvalidStateError` rather than dispatched as
 * `--model <bogus>`.
 */
export type ClaudeModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
] as const;

export const isClaudeModel = (s: string): s is ClaudeModel => (CLAUDE_MODELS as readonly string[]).includes(s);
