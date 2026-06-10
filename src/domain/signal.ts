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
 * One dimension verdict on the evaluator's PASS / FAIL rubric. `passed: true` is the only
 * positive verdict — there is no middle ground, no numeric score. The `finding` is mandatory
 * non-empty when `passed: false` (enforced by the persistence-layer Zod schema).
 *
 * `executionEvidence` is the verbatim command output for dimensions paired with an `auto`
 * verification criterion — the reviewer runs the criterion's command and records the tail of
 * stdout/stderr so an operator can audit the verdict without re-running the spawn. Optional at
 * the schema layer (the auto/manual partitioning lives on the task contract, not the signal),
 * prompt-enforced for auto criteria.
 */
export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  readonly passed: boolean;
  readonly finding: string;
  readonly executionEvidence?: string;
}

/**
 * The four floor dimensions every terminal evaluator verdict MUST grade. They are the
 * always-present rubric pinned in the evaluate prompt (`prompts/evaluate/template.md`); the
 * planner may append task-specific dimensions on top, but these four are mandatory on every
 * `passed` / `failed` verdict so a vacuous "passed with zero dimensions" can never validate.
 *
 * Names are compared case-/whitespace-insensitively (lowercased, trimmed) by the signal-schema
 * refinement and by `failedDimensions` in the plateau predicate, so the canonical lowercase
 * spelling here is the single source of truth the integration schema imports (domain → integration
 * is the allowed direction).
 *
 * @public
 */
export const FLOOR_DIMENSIONS = ['correctness', 'completeness', 'safety', 'consistency'] as const;

/**
 * Outcome of an evaluator run. The signal carries a PASS / FAIL verdict (`status`), the
 * per-dimension findings (`dimensions`), and an optional `critique` the generator reads on
 * the next round. Per the evaluator-rubric redesign, no numeric score field is persisted —
 * `passed` is the only verdict on each dimension and `status: 'passed'` requires every
 * dimension to pass.
 */
export interface EvaluationSignal {
  readonly type: 'evaluation';
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly DimensionScore[];
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
 * A learning the AI surfaced, structured into three parts:
 *
 *  - `text` — the **Insight**: the actionable one-line claim (required). The field keeps the
 *    name `text` for back-compat with v1 ledger rows.
 *  - `context` — the **Context**: when / why the insight arose (optional).
 *  - `appliesTo` — the **Applies-to**: where it applies — repo area, task kind, subsystem
 *    (optional).
 *
 * Shared by {@link LearningSignal} and the implement / procedural-memory pipelines so business
 * and application code can carry the structured shape without importing a signal type. It lives
 * in this domain file so neither layer needs to reach across a layer boundary for it.
 */
export interface LearningEntry {
  readonly text: string;
  readonly context?: string;
  readonly appliesTo?: string;
}

/**
 * Generator-emitted insight worth pinning at the top of the sprint's `progress.md` under a
 * `## Learnings` section. Carries forward across tasks (cross-task knowledge: a gotcha, a
 * non-obvious project convention discovered mid-flow). Lower-stakes than `DecisionSignal`.
 *
 * Extends {@link LearningEntry} (Insight + optional Context + optional Applies-to) with the
 * signal discriminant and emission timestamp.
 */
export interface LearningSignal extends LearningEntry {
  readonly type: 'learning';
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
 * One structured per-module verify gate proposed by `detect-scripts` for a monorepo-style repo.
 * Mirrors the `VerifyGate` domain shape (`repository.ts`) at the signal boundary so the gates
 * round-trip onto {@link Repository.verifyGates} unchanged.
 *
 *  - `pathPrefix` — POSIX-style path prefix relative to the repo root that scopes the gate. `''`
 *    (empty string) is the catch-all that matches everything — used only for cross-module
 *    integration checks.
 *  - `command` — the verbatim shell line to run for this module, lifted from the module's own
 *    tooling.
 *  - `timeoutMs` — optional per-gate wall-clock cap.
 */
export interface VerifyGateProposal {
  readonly pathPrefix: string;
  readonly command: string;
  readonly timeoutMs?: number;
}

/**
 * Structured per-module verify gates proposed by the `detect-scripts` flow for monorepo-style
 * repositories — distinct module roots (separate build manifests in subdirectories), each
 * verified by its own command. ADDITIVE to {@link VerifyScriptSignal}: a single-module repo
 * proposal carries `verify-script` only; a monorepo proposal carries `verify-script` (the legacy
 * catch-all fallback the operator sees) AND `verify-gates`. The gates persist onto
 * {@link Repository.verifyGates}, which wins over `verifyScript` when present and non-empty.
 *
 * Empty `gates` is not the canonical "no gates" state — the AI omits the signal entirely for
 * single-module repos; the schema rejects an empty array so an accidental empty emission cannot
 * masquerade as a meaningful "no modules" proposal.
 */
export interface VerifyGatesSignal {
  readonly type: 'verify-gates';
  readonly gates: readonly VerifyGateProposal[];
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
 * AI-provider context-window compaction event. Emitted when the underlying CLI auto-compacts its
 * working context (Claude / Copilot / Codex all do this transparently in long sessions). First-
 * class lifecycle moment per the Anthropic harness-engineering guidance: the operator should be
 * able to see when the model's working memory was rebuilt so an apparent regression mid-task
 * can be attributed to the compaction boundary instead of the prompt.
 *
 *  - `beforeTokens` / `afterTokens` are the provider-reported token counts before and after the
 *    compaction. Both optional — providers vary on what they expose. When neither is present the
 *    marker renders as a bare "context compacted" boundary.
 *  - `preservedTopics` is the optional list of topic / summary headings the provider says it
 *    retained. Empty / absent when the provider does not name what it kept.
 *
 * Per-provider emission status: no provider currently produces this signal. The harness moved
 * to a file-based contract (`signals.json` written by the AI) under audit [09], so a compaction
 * marker would need the AI itself to self-report a vendor lifecycle event — none of Claude Code,
 * GitHub Copilot, or OpenAI Codex surfaces this on the file-based contract today. The type +
 * Zod schema + TUI marker rendering remain in place as a forward-compatible target so emitters
 * can land incrementally once a vendor exposes a stable marker.
 */
export interface ContextCompactedSignal {
  readonly type: 'context-compacted';
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly preservedTopics?: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Generator-proposed commit message for the harness's per-task commit. The harness owns the
 * actual `git commit` call (commit-task leaf); this signal lets the generator influence the
 * message without taking control of the operation.
 *
 *  - `subject` is the first line. Convention: imperative present-tense, ≤72 chars; the harness
 *    clamps before committing.
 *  - `body` is optional and may span multiple paragraphs. Convention: wrap at 72 chars,
 *    explain the why, not the what.
 *
 * A ` (#123, !456)` subject suffix is appended by the commit-task leaf at `git commit -F` time
 * when the task carries external refs — it is not threaded back onto the signal. UI surfaces
 * show the AI-authored subject + body; reviewers see the suffixed subject in `git log`.
 *
 * When the signal is absent the harness falls back to its auto-generated default
 * (`task(<short-id>): <task-name>`).
 */
export interface CommitMessageSignal {
  readonly type: 'commit-message';
  readonly subject: string;
  readonly body?: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * One refined-ticket proposal — produced by the refine flow's AI session. Carries the
 * AI-authored requirements body verbatim; the harness projects the body onto the
 * `PendingTicket` entity via `refineTicketUseCase` (which gates approval through an optional
 * reviewer callback). No sidecar — the harness mutates the ticket directly.
 *
 *  - `body` is markdown prose; uncapped on persistence per audit [03].
 */
export interface RefinedTicketSignal {
  readonly type: 'refined-ticket';
  readonly body: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * One plan proposal — produced by the plan flow's AI session. Carries the structured task
 * envelope the planner emitted; downstream code resolves cross-references (projectPath →
 * Repository, blockedBy → TaskId) via `parseTaskList`. No sidecar; the harness projects the
 * tasks onto the sprint's task list via `planSprintUseCase`.
 *
 *  - `tasksJson` is the raw JSON body the AI wrote, retained verbatim so the existing
 *    domain-aware parser (`parsePlanOutput` → `parseTaskList`) keeps owning cross-reference
 *    resolution. When Wave 6 swaps the prompt to ask for the structured shape directly, this
 *    field will be replaced by the validated `TaskImportSpec[]` payload; until then the
 *    string preserves the legacy round-trip.
 */
export interface TaskPlanSignal {
  readonly type: 'task-plan';
  readonly tasksJson: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * One ideate proposal — produced by the ideate flow's AI session. Carries the requirements
 * body plus the structured task envelope; downstream code resolves cross-references and
 * approves the ticket via `addApprovedTicketUseCase`. No sidecar; the harness projects both
 * onto the sprint.
 *
 *  - `outputJson` is the raw JSON body the AI wrote, retained verbatim so the existing
 *    parser (`parseIdeateOutput` → `parseTaskList`) keeps owning ticket / task resolution.
 *    Wave 6 replaces this with structured fields when the prompt-side contract lands.
 */
export interface IdeatedTicketsSignal {
  readonly type: 'ideated-tickets';
  readonly outputJson: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * One PR-content proposal — produced by the create-pr flow's optional AI authoring step.
 * Carries an AI-authored pull-request title + body the harness threads into `gh pr create` /
 * `glab mr create`. No sidecar consumer mutates a domain entity from this signal; the
 * downstream `create-pr` leaf reads it off ctx and prefers it over the template-derived
 * default.
 *
 *  - `title` is a one-line PR title (convention: ≤70 chars, imperative form — enforced by the
 *    prompt, not the schema, so an over-length title still validates and the platform's own
 *    truncation rules apply).
 *  - `body` is markdown prose. Uncapped on persistence; the platform CLI handles size limits.
 *
 * The shape is intentionally closed for modification (OCP). Future PR-authoring extensions
 * (labels, reviewers, draft-rationale, …) MUST land as additional signal kinds — never by
 * widening this one.
 */
export interface PrContentSignal {
  readonly type: 'pr-content';
  readonly title: string;
  readonly body: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Discriminated union of every signal type the harness understands. Narrows by the `type` tag;
 * exhaustive `switch` statements should close with `const _exhaustive: never = signal` so
 * adding a variant is a compile error at every consumer until handled.
 *
 * Naming: this used to be called `HarnessSignal`. The new contract ([09]) names them
 * `AiSignal` to clarify that the AI session is the producer. The alias below carries the
 * legacy name forward for in-flight consumers; per-leaf migration progressively replaces
 * `HarnessSignal` references with `AiSignal`.
 */
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
  | PrContentSignal;

/**
 * Canonical name for the AI-produced signal union under the [09] contract. Currently aliased
 * to {@link HarnessSignal}; per-leaf migration ([09] step 5) progressively swaps consumers
 * over and a later pass collapses the union back into a single name.
 */
export type AiSignal = HarnessSignal;
