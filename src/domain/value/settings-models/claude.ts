// Verified against `claude --help` / `claude config get` (Claude Code v2.x); Opus 5.5 / Fable 5.1
// live-probed on Claude Code 2.1.280 (2026-09-22); Sonnet 5.5 on Claude Code 2.1.285 (2026-09-30);
// Haiku 5.5 from the Claude Code CHANGELOG (>= 2.1.293) + platform model overview (2026-10-11).
// Docs: https://docs.claude.com/en/docs/claude-code/cli-reference

/**
 * Models supported by the Claude Code CLI adapter. Domain-owned: persisted Settings reference
 * these identifiers; adapters consume them when invoking the CLI subprocess. The adapter still
 * validates `AiSession.model` against this set at the boundary so a stale persisted value or
 * mistyped CLI input is caught with `InvalidStateError` rather than dispatched as
 * `--model <bogus>`.
 *
 * `claude-opus-5-5` (Claude Code >= 2.1.280, 2026-09-22) is the current Opus: cheaper than Opus 5
 * ($4/$20 vs $5/$25 per MTok), natively 1M in Claude Code (default AND max, so NO `[1m]`
 * variant), 128K output, and the top of the built-in Claude-Code escalation ladder. Its CLI
 * default effort is `medium` (every other effort-capable Claude model defaults to `high`), which
 * is why ralphctl never relies on the implicit default — see `escalation-map.ts`.
 * `claude-opus-5` and `claude-opus-4-8` are kept so pinned configs keep working; both carry a
 * ladder rung to Opus 5.5.
 *
 * `claude-fable-5-1` is the frontier tier above Opus (successor to `claude-fable-5`, same
 * $10/$50 price — 2.5x Opus 5.5), natively 1M default AND max, so it has no `[1m]` variant. It
 * requires 30-day data retention: zero-data-retention orgs get a 400. `claude-fable-5` stays for
 * pinned configs. Fable is never a provider default or a built-in escalation rung; only the
 * frontier presets pick it (on their deep flows). Elsewhere opt in per row, or via
 * `settings.harness.escalationMap` (e.g. `'claude-opus-5-5': 'claude-fable-5-1'`).
 *
 * The `[1m]` suffix is Claude Code's long-context (1M-token) variant syntax for models whose
 * Claude-Code default window is 200K — a literal part of the `--model` value, passed through
 * verbatim (argv array, never a shell — the brackets cannot glob). Only `claude-opus-4-8[1m]` and
 * `claude-fable-5[1m]` carry it; both are opt-in only (no preset, default, or ladder rung).
 *
 * `claude-sonnet-5-5` (Claude Code >= 2.1.284) is the default Sonnet and the preset pick: $2/$10
 * per MTok, natively 1M with no `[1m]` variant, all five effort levels, and — like Opus 5.5 — a
 * CLI default effort of `medium` (code.claude.com/docs/en/model-config). Copilot serves the same
 * model under the dotted id `claude-sonnet-5.5`.
 * `claude-sonnet-5` is NOT retired: it stays live (and is Claude Code's cybersecurity fallback
 * for Sonnet 5.5), keeps its own ladder rung to Opus 5.5, and pinned configs load unchanged.
 * `claude-sonnet-4-6` is kept too (still Active at Anthropic) so configs pinned to 4.6 keep
 * working. The 1M figures are recorded in the context-window tables against the bare ids.
 *
 * `claude-haiku-5-5` (Claude Code >= 2.1.293) succeeds Haiku 4.5: natively 1M, all five effort
 * levels, CLI default `medium`. `claude-haiku-4-5` (no effort dimension) stays for pinned configs.
 */
export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-haiku-5-5'
  | 'claude-sonnet-4-6'
  | 'claude-sonnet-5'
  | 'claude-sonnet-5-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-8[1m]'
  | 'claude-opus-5'
  | 'claude-opus-5-5'
  | 'claude-fable-5'
  | 'claude-fable-5[1m]'
  | 'claude-fable-5-1';

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  'claude-haiku-4-5',
  'claude-haiku-5-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5[1m]',
  'claude-fable-5-1',
] as const;

export const isClaudeModel = (s: string): s is ClaudeModel => (CLAUDE_MODELS as readonly string[]).includes(s);

const ALL_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Effort levels each catalog model accepts on `--effort`. Haiku 4.5 has no effort dimension and
 * Sonnet 4.6 has no `xhigh`; every other catalog model takes all five. Total over `ClaudeModel`
 * so a new catalog id must be classified here.
 */
export const CLAUDE_MODEL_EFFORT_LEVELS: Readonly<Record<ClaudeModel, readonly string[]>> = {
  'claude-haiku-4-5': [],
  'claude-haiku-5-5': ALL_CLAUDE_EFFORTS,
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-5': ALL_CLAUDE_EFFORTS,
  'claude-sonnet-5-5': ALL_CLAUDE_EFFORTS,
  'claude-opus-4-8': ALL_CLAUDE_EFFORTS,
  'claude-opus-4-8[1m]': ALL_CLAUDE_EFFORTS,
  'claude-opus-5': ALL_CLAUDE_EFFORTS,
  'claude-opus-5-5': ALL_CLAUDE_EFFORTS,
  'claude-fable-5': ALL_CLAUDE_EFFORTS,
  'claude-fable-5[1m]': ALL_CLAUDE_EFFORTS,
  'claude-fable-5-1': ALL_CLAUDE_EFFORTS,
};
