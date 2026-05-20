import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Harness signals — discriminated union of every structured signal the harness can extract from
 * AI agent output during a run. Adapters speak this vocabulary; adding a variant is a closed
 * change (every `switch` on `HarnessSignal['type']` is exhaustiveness-checked via
 * `const _exhaustive: never = signal`).
 *
 * Domain rules:
 *  - Timestamps are `IsoTimestamp` (the domain VO) — adapters convert raw `Date` at the parser
 *    boundary, never inside domain code.
 *  - `EvaluationDimension` is free-form; normalisation (e.g. lowercasing) is an adapter concern.
 *
 * This module is **not** a barrel — it is one cohesive discriminated-union module.
 */

/** Free-form dimension identifier emitted by the evaluator (e.g. `correctness`, `performance`). */
export type EvaluationDimension = string;

/**
 * Numeric score on the 1–5 rubric:
 *   5 = exemplary · 4 = solid · 3 = adequate · 2 = below bar · 1 = unacceptable
 *
 * Scores ≥ 4 map to `passed: true`; 1–3 map to `passed: false`.
 */
export type DimensionScoreValue = 1 | 2 | 3 | 4 | 5;

export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  readonly score: DimensionScoreValue;
  readonly passed: boolean;
  readonly finding: string;
}

export interface ProgressSignal {
  readonly type: 'progress';
  readonly summary: string;
  readonly files?: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Outcome of an evaluator run. `overallScore` is the mean of dimension scores rounded to one
 * decimal; undefined when there are no dimensions (e.g. `malformed` with empty list).
 */
export interface EvaluationSignal {
  readonly type: 'evaluation';
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly DimensionScore[];
  readonly overallScore?: number;
  readonly critique?: string;
  readonly timestamp: IsoTimestamp;
}

/** Only valid after a `TaskVerifiedSignal`. Ordering enforced by parser/scheduler, not the type. */
export interface TaskCompleteSignal {
  readonly type: 'task-complete';
  readonly timestamp: IsoTimestamp;
}

export interface TaskVerifiedSignal {
  readonly type: 'task-verified';
  readonly output: string;
  readonly timestamp: IsoTimestamp;
}

export interface TaskBlockedSignal {
  readonly type: 'task-blocked';
  readonly reason: string;
  readonly timestamp: IsoTimestamp;
}

export interface NoteSignal {
  readonly type: 'note';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-emitted insight worth pinning at the top of the sprint's `progress.md` under a
 * `## Learnings` section. Carries forward across tasks (cross-task knowledge: a gotcha, a
 * non-obvious project convention discovered mid-flow). Lower-stakes than `DecisionSignal`.
 */
export interface LearningSignal {
  readonly type: 'learning';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-emitted record of a concrete change made during a task — appended inline to the
 * task's section in `progress.md`. Granular ("added X", "renamed Y to Z"), not architectural.
 */
export interface ChangeSignal {
  readonly type: 'change';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-emitted architectural / design decision worth pinning under `## Decisions` in
 * `progress.md`. Higher signal than `LearningSignal`: an intentional choice with rationale,
 * not an observation.
 */
export interface DecisionSignal {
  readonly type: 'decision';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Setup-time signal from a one-shot AI session (`project add` / `project repo add`). Carries the
 * raw shell command the AI proposes as the verification gate. Empty/missing means no proposal.
 */
export interface CheckScriptDiscoverySignal {
  readonly type: 'check-script-discovery';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Context-file proposal from `project readiness`. Body becomes a provider-native context file
 * (`CLAUDE.md` for Claude, `.github/copilot-instructions.md` for Copilot, `AGENTS.md` for
 * Codex). The originating wire tag (`<claude-md>` / `<copilot-instructions>` / `<agents-md>`)
 * is captured so the readiness leaf can verify the AI emitted the tool-specific tag.
 */
export interface AgentsMdProposalSignal {
  readonly type: 'agents-md-proposal';
  /** Originating wire tag: `'claude-md'`, `'copilot-instructions'`, or `'agents-md'`. */
  readonly tag: 'claude-md' | 'copilot-instructions' | 'agents-md';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * `<setup-skill>` proposal body from `detect-skills`. Multi-paragraph markdown describing the
 * project's setup convention; the chain renders this as a skill file the AI later links into
 * its working dir. Empty / missing → the AI judged "no skill needed."
 */
export interface SetupSkillProposalSignal {
  readonly type: 'setup-skill-proposal';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * `<verify-skill>` proposal body from `detect-skills`. Same shape and lifecycle as
 * {@link SetupSkillProposalSignal} but for verification conventions.
 */
export interface VerifySkillProposalSignal {
  readonly type: 'verify-skill-proposal';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * One shell command to install dependencies / prepare the repo for an agentic session.
 * Hostile shapes (pipe-to-shell, `eval`, `rm -rf`) are dropped at the parser boundary.
 */
export interface SetupScriptSignal {
  readonly type: 'setup-script';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/** One shell command chain for the post-task gate. Same security denylist as `SetupScriptSignal`. */
export interface VerifyScriptSignal {
  readonly type: 'verify-script';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Zero or more kebab-case skill names the AI proposes linking into the agentic working
 * directory (e.g. `react-patterns`, `nextjs-app-router`). Empty `names` is the canonical
 * "no suggestions" state.
 */
export interface SkillSuggestionsSignal {
  readonly type: 'skill-suggestions';
  readonly names: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Structured per-task progress entry — the v1 4-section block (`task` / `filesChanged` /
 * `learnings` / `notesForNext`) emitted by the generator and rendered as a single section
 * inside `<sprintDir>/progress.md`. Higher-fidelity than the legacy short-form `<progress>`
 * one-liner; both stay supported, the progress sink decides how to render each.
 *
 * Domain rules:
 *  - `task` is the human-readable task identifier the generator just worked on (typically the
 *    task name). The signal carries narrative only — the harness injects git facts
 *    (commit SHA, files actually touched) from the `commit-task` leaf, NOT from this signal.
 *  - `filesChanged` is the generator's own list of files it intentionally edited this round;
 *    may be empty if the work was investigative. The harness may augment with git-derived
 *    facts at render time.
 *  - `learnings` and `notesForNext` are free-form prose. Empty strings are valid and render
 *    as `_None._` so the v1 4-section shape is preserved on disk.
 */
export interface ProgressEntrySignal {
  readonly type: 'progress-entry';
  readonly task: string;
  readonly filesChanged: readonly string[];
  readonly learnings: string;
  readonly notesForNext: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-proposed commit message for the harness's per-task commit. The harness owns the
 * actual `git commit` call (commit-task leaf); this signal lets the generator influence the
 * message without taking control of the operation.
 *
 *  - `subject` is the first line. Convention: imperative present-tense, ≤72 chars; the parser
 *    trims it but does not enforce length — the harness clamps before committing.
 *  - `body` is optional and may span multiple paragraphs. Convention: wrap at 72 chars,
 *    explain the why, not the what.
 *  - `fullMessage` is the resolved commit message AS WRITTEN TO GIT — subject + body +
 *    deterministic trailers (`Closes #…`) appended by the harness. Populated by the
 *    commit-task leaf when it re-emits the signal after the message is finalised; absent on
 *    the parse-time signal (the AI never sees the trailer it cannot author). UI surfaces and
 *    audit log consumers should prefer `fullMessage` when present.
 *
 * When the signal is absent the harness falls back to its auto-generated default
 * (`task(<short-id>): <task-name>`).
 */
export interface CommitMessageSignal {
  readonly type: 'commit-message';
  readonly subject: string;
  readonly body?: string;
  readonly fullMessage?: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Discriminated union of every harness signal type. Narrows by the `type` tag; exhaustive
 * `switch` statements should close with `const _exhaustive: never = signal` so adding a variant
 * is a compile error at every consumer until handled.
 */
export type HarnessSignal =
  | ProgressSignal
  | ProgressEntrySignal
  | EvaluationSignal
  | TaskCompleteSignal
  | TaskVerifiedSignal
  | TaskBlockedSignal
  | NoteSignal
  | LearningSignal
  | ChangeSignal
  | DecisionSignal
  | CheckScriptDiscoverySignal
  | AgentsMdProposalSignal
  | SetupScriptSignal
  | VerifyScriptSignal
  | SetupSkillProposalSignal
  | VerifySkillProposalSignal
  | SkillSuggestionsSignal
  | CommitMessageSignal;
