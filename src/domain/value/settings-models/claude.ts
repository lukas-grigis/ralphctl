// Verified against `claude --help` / `claude config get` (Claude Code v2.x).
// Docs: https://docs.claude.com/en/docs/claude-code/cli-reference

/**
 * Models supported by the Claude Code CLI adapter. Domain-owned: persisted Settings reference
 * these identifiers; adapters consume them when invoking the CLI subprocess. The adapter still
 * validates `AiSession.model` against this set at the boundary so a stale persisted value or
 * mistyped CLI input is caught with `InvalidStateError` rather than dispatched as
 * `--model <bogus>`.
 *
 * `claude-fable-5` is the frontier tier above Opus 5; the `[1m]` suffix is Claude Code's
 * long-context (1M-token) variant syntax for the same model — a literal part of the `--model`
 * value, passed through verbatim (argv array, never a shell — the brackets cannot glob). Opus
 * ships a `[1m]` variant too: on large repos the long window avoids mid-session compaction,
 * which is the practical "better and faster" for deep implement runs. The `[1m]` and fable
 * entries are deliberate opt-in only: none is referenced by presets, defaults, or the built-in
 * escalation ladder — pick one per row, or extend `settings.harness.escalationMap` with a rung
 * such as `'claude-opus-5': 'claude-fable-5'`.
 *
 * `claude-sonnet-5` is the Sonnet-5 successor to Sonnet 4.6 and the default Sonnet across
 * presets / defaults / the escalation ladder; `claude-sonnet-4-6` is KEPT alongside it (both
 * remain Active at Anthropic) so configs pinned to 4.6 keep working. Sonnet 5 has NO `[1m]`
 * variant — on the Anthropic API it always runs at its native 1M window in Claude Code (there is
 * no 200K default to opt out of), unlike Opus/Fable whose Claude-Code default is 200K and whose
 * `[1m]` suffix is the real 1M selector. The 1M figure is recorded in the context-window tables
 * against the bare id, not via a suffix.
 *
 * `claude-opus-5` is the Opus 4.8 successor at the same price and the **default Opus** across
 * presets, new-install defaults, and the escalation ladder; natively 1M in Claude Code (default
 * AND max) so — like `claude-sonnet-5` — it has **no `[1m]` variant**; 128K output; separate
 * rate-limit bucket from Opus 4.x. `claude-opus-4-8` is kept so pinned configs work (and now
 * carries a ladder rung to Opus 5).
 */
export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-8[1m]'
  | 'claude-opus-5'
  | 'claude-fable-5'
  | 'claude-fable-5[1m]';

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-5',
  'claude-fable-5',
  'claude-fable-5[1m]',
] as const;

export const isClaudeModel = (s: string): s is ClaudeModel => (CLAUDE_MODELS as readonly string[]).includes(s);
