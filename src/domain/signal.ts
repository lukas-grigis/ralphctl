import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Every structured signal the harness extracts from AI output. Adapters convert raw dates to
 * `IsoTimestamp` at the parser boundary; dimension-name normalisation is an adapter concern.
 */

/** Free-form dimension identifier emitted by the evaluator (e.g. `correctness`, `performance`). */
export type EvaluationDimension = string;

/**
 * One PASS / FAIL verdict on the evaluator's rubric — no numeric score. `finding` is required
 * non-empty on a fail. `applicable: false` means the dimension does not apply to this change, so
 * `passed` is not a graded verdict and `finding` carries the reason. `executionEvidence` is the
 * command-output tail for dimensions paired with an `auto` criterion.
 */
export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  readonly passed: boolean;
  readonly finding: string;
  readonly executionEvidence?: string;
  readonly applicable?: boolean;
}

/**
 * The evaluator's verdict on one task-specific acceptance criterion, keyed by
 * {@link VerificationCriterion.id} — orthogonal to the floor-rubric {@link DimensionScore}s.
 */
export interface CriterionVerdict {
  readonly id: string;
  readonly passed: boolean;
  /** One-line citation (command tail, `path:line`) backing the verdict. */
  readonly evidence?: string;
}

/**
 * Evaluator outcome. `status: 'passed'` requires every dimension — and every listed criterion — to
 * pass (enforced by the persistence-layer schema). `critique` feeds the generator's next round.
 */
export interface EvaluationSignal {
  readonly type: 'evaluation';
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly DimensionScore[];
  readonly criteria?: readonly CriterionVerdict[];
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

/**
 * The generator's own classification of an information gap (HiL-Bench taxonomy). Orthogonal to
 * the harness's structural `BlockCause`; an environment or verification failure fits none of these.
 */
export type TaskBlockerClass = 'missing-information' | 'ambiguous-request' | 'contradictory-information';

/** The triage fields are optional so a reason-only signal still validates. */
export interface TaskBlockedSignal {
  readonly type: 'task-blocked';
  readonly reason: string;
  readonly blockerClass?: TaskBlockerClass;
  /** The single concrete question that, answered, unblocks the task. */
  readonly question?: string;
  /** What the operator (or a future session) needs to supply or decide to unblock. */
  readonly whatUnblocksMe?: string;
  readonly timestamp: IsoTimestamp;
}

export interface NoteSignal {
  readonly type: 'note';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/** A structured learning: `text` is the insight (named for v1 ledger compatibility). */
export interface LearningEntry {
  readonly text: string;
  /** When / why the insight arose. */
  readonly context?: string;
  /** Where it applies — repo area, task kind, subsystem. */
  readonly appliesTo?: string;
}

/** Cross-task insight pinned under `## Learnings` in `progress.md`. */
export interface LearningSignal extends LearningEntry {
  readonly type: 'learning';
  readonly timestamp: IsoTimestamp;
}

/** A granular change ("added X") appended to the task's `progress.md` section. */
export interface ChangeSignal {
  readonly type: 'change';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/** An intentional design choice with rationale, pinned under `## Decisions` in `progress.md`. */
export interface DecisionSignal {
  readonly type: 'decision';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/** Readiness context-file proposal; `tag` lets the leaf check the AI used its provider's own tag. */
export interface AgentsMdProposalSignal {
  readonly type: 'agents-md-proposal';
  readonly tag: 'claude-md' | 'copilot-instructions' | 'agents-md';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/** `<setup-skill>` body from `detect-skills`; empty / missing means no skill is needed. */
export interface SetupSkillProposalSignal {
  readonly type: 'setup-skill-proposal';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/** `<verify-skill>` body from `detect-skills`; same lifecycle as {@link SetupSkillProposalSignal}. */
export interface VerifySkillProposalSignal {
  readonly type: 'verify-skill-proposal';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/** Hostile shapes (pipe-to-shell, `eval`, `rm -rf`) are dropped at the parser boundary. */
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

/** Mirrors the domain `VerifyGate` so proposals round-trip onto {@link Repository.verifyGates}. */
export interface VerifyGateProposal {
  /** Repo-relative POSIX prefix; `''` is the catch-all, for cross-module checks only. */
  readonly pathPrefix: string;
  readonly command: string;
  readonly timeoutMs?: number;
}

/**
 * Per-module gates for a monorepo, alongside the catch-all `verify-script`. Single-module repos
 * omit the signal; the schema rejects an empty `gates` array.
 */
export interface VerifyGatesSignal {
  readonly type: 'verify-gates';
  readonly gates: readonly VerifyGateProposal[];
  readonly timestamp: IsoTimestamp;
}

/** Kebab-case skill names to link into the working dir; empty is the canonical "none". */
export interface SkillSuggestionsSignal {
  readonly type: 'skill-suggestions';
  readonly names: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Provider context-window compaction marker, so a mid-task regression can be attributed to it. No
 * provider emits it on the file-based contract today; schema and TUI rendering are kept for when one does.
 */
export interface ContextCompactedSignal {
  readonly type: 'context-compacted';
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly preservedTopics?: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-proposed message for the harness-owned per-task commit. The harness clamps the subject
 * and appends any external-ref suffix at commit time; absent → `task(<short-id>): <task-name>`.
 */
export interface CommitMessageSignal {
  readonly type: 'commit-message';
  readonly subject: string;
  readonly body?: string;
  readonly timestamp: IsoTimestamp;
}

/** Refine output: the requirements body, projected onto the ticket by `refineTicketUseCase`. */
export interface RefinedTicketSignal {
  readonly type: 'refined-ticket';
  readonly body: string;
  readonly timestamp: IsoTimestamp;
}

/** Plan output: the raw JSON, kept verbatim so `parsePlanOutput` owns cross-reference resolution. */
export interface TaskPlanSignal {
  readonly type: 'task-plan';
  readonly tasksJson: string;
  readonly timestamp: IsoTimestamp;
}

/** Ideate output: the raw JSON, kept verbatim so `parseIdeateOutput` owns ticket / task resolution. */
export interface IdeatedTicketsSignal {
  readonly type: 'ideated-tickets';
  readonly outputJson: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * AI-authored PR title + body, preferred over the template default. Extensions (labels, reviewers,
 * …) land as new signal kinds, never by widening this one.
 */
export interface PrContentSignal {
  readonly type: 'pr-content';
  readonly title: string;
  readonly body: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * The failing test a `reproduce` session wrote before any fix; the generator must make it pass
 * without weakening it. Research: `.claude/docs/RESEARCH-REFERENCES.md` (ORACLE-SWE, TestPrune).
 */
export interface ReproductionSignal {
  readonly type: 'reproduction';
  readonly testPath: string;
  readonly runCommand: string;
  /** Bounded failing-output excerpt — evidence it fails for the reported reason, not a setup error. */
  readonly observedFailure: string;
  /** Empty (not omitted) when the session searched and found none. */
  readonly relevantTests: readonly string[];
  readonly notes?: string;
  /** Absent means `true`. On `false` the three test fields may be empty strings. */
  readonly reproduced?: boolean;
  /** Why the defect was not reproduced; only with `reproduced: false`. */
  readonly reason?: string;
  readonly timestamp: IsoTimestamp;
}

/** Best-of-N pairwise verdict over two candidates' compact summaries. */
export interface CandidateSelectionSignal {
  readonly type: 'candidate-selection';
  /** 1-based candidate index; `0` declares a tie. */
  readonly winner: number;
  /** Cites concrete evidence from the summaries, not a bare confidence claim. */
  readonly rationale: string;
  readonly timestamp: IsoTimestamp;
}

/** Close exhaustive switches with `const _exhaustive: never = signal`. */
export type HarnessSignal =
  | EvaluationSignal
  | TaskCompleteSignal
  | TaskVerifiedSignal
  | TaskBlockedSignal
  | NoteSignal
  | LearningSignal
  | ChangeSignal
  | DecisionSignal
  | AgentsMdProposalSignal
  | SetupScriptSignal
  | VerifyScriptSignal
  | VerifyGatesSignal
  | SetupSkillProposalSignal
  | VerifySkillProposalSignal
  | SkillSuggestionsSignal
  | CommitMessageSignal
  | ContextCompactedSignal
  | RefinedTicketSignal
  | TaskPlanSignal
  | IdeatedTicketsSignal
  | PrContentSignal
  | ReproductionSignal
  | CandidateSelectionSignal;

export type AiSignal = HarnessSignal;
