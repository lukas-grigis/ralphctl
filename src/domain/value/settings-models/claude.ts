// Verified against `claude --help` / `claude config get` (Claude Code v2.x).
// Docs: https://docs.claude.com/en/docs/claude-code/cli-reference

/**
 * Models supported by the Claude Code CLI adapter. Domain-owned: persisted Settings reference
 * these identifiers; adapters consume them when invoking the CLI subprocess. The adapter still
 * validates `AiSession.model` against this set at the boundary so a stale persisted value or
 * mistyped CLI input is caught with `InvalidStateError` rather than dispatched as
 * `--model <bogus>`.
 *
 * `claude-fable-5` is the frontier tier above Opus 4.8; the `[1m]` suffix is Claude Code's
 * long-context (1M-token) variant syntax for the same model — a literal part of the `--model`
 * value, passed through verbatim (argv array, never a shell — the brackets cannot glob).
 * Catalog membership is deliberate opt-in only: neither fable id is referenced by presets,
 * defaults, or the built-in escalation ladder — pick it per row, or extend
 * `settings.harness.escalationMap` with an `'claude-opus-4-8': 'claude-fable-5'` rung.
 */
export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8'
  | 'claude-fable-5'
  | 'claude-fable-5[1m]';

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-fable-5[1m]',
] as const;

export const isClaudeModel = (s: string): s is ClaudeModel => (CLAUDE_MODELS as readonly string[]).includes(s);
