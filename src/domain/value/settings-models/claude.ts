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
 * value, passed through verbatim (argv array, never a shell — the brackets cannot glob). Opus
 * ships a `[1m]` variant too: on large repos the long window avoids mid-session compaction,
 * which is the practical "better and faster" for deep implement runs. The `[1m]` and fable
 * entries are deliberate opt-in only: none is referenced by presets, defaults, or the built-in
 * escalation ladder — pick one per row, or extend `settings.harness.escalationMap` with a rung
 * such as `'claude-opus-4-8': 'claude-fable-5'`.
 */
export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8'
  | 'claude-opus-4-8[1m]'
  | 'claude-fable-5'
  | 'claude-fable-5[1m]';

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-fable-5',
  'claude-fable-5[1m]',
] as const;

export const isClaudeModel = (s: string): s is ClaudeModel => (CLAUDE_MODELS as readonly string[]).includes(s);
