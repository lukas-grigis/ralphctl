/**
 * Harness signals — discriminated union of every structured signal the
 * harness can extract from AI agent output during a run.
 *
 * Adapters (signal parser, file-system handler, signal bus) speak this
 * vocabulary. Adding a variant is a closed change: every `switch` on
 * `HarnessSignal['type']` is exhaustiveness-checked by the compiler via
 * `const _exhaustive: never = signal`.
 *
 * Domain rules:
 *  - Timestamps are `IsoTimestamp` (the domain VO) — adapters convert raw
 *    `Date` instances at the parser boundary, never inside domain code.
 *  - `EvaluationDimension` is a free-form string. The parser is responsible
 *    for normalisation (e.g. lowercasing) at the boundary; that's an
 *    integration concern, not a domain invariant.
 *
 * This module is **not** a barrel — it is one cohesive discriminated-union
 * module. All variants live here together because they share the
 * `_exhaustive: never` exhaustiveness contract.
 */
import type { IsoTimestamp } from '../values/iso-timestamp.ts';

/**
 * Free-form dimension identifier emitted by the evaluator. Examples include
 * the four floor dimensions (`correctness`, `completeness`, `safety`,
 * `consistency`) and any planner-emitted extras (`performance`,
 * `accessibility`, `migration-safety`, …).
 */
export type EvaluationDimension = string;

/**
 * One graded dimension from an evaluator's output. Parsed from lines like
 * `**Name**: PASS|FAIL — one-line finding`.
 */
export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  readonly passed: boolean;
  readonly finding: string;
}

/**
 * Progress signal — AI agent reports progress on the current task. The
 * harness appends a timestamped entry to `progress.md` per signal.
 */
export interface ProgressSignal {
  readonly type: 'progress';
  readonly summary: string;
  readonly files?: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Evaluation signal — outcome of an evaluator run after a task settles.
 *
 *  - `passed`     — `<evaluation-passed>` tag found.
 *  - `failed`     — `<evaluation-failed>` tag found, or one or more dimensions failed.
 *  - `malformed`  — neither tag was found and no dimension lines parsed.
 */
export interface EvaluationSignal {
  readonly type: 'evaluation';
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly DimensionScore[];
  readonly critique?: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Task complete signal — AI agent declares the task finished. Only valid
 * after a `TaskVerifiedSignal` has already been processed (the parser and
 * scheduler enforce the ordering, not the type).
 */
export interface TaskCompleteSignal {
  readonly type: 'task-complete';
  readonly timestamp: IsoTimestamp;
}

/**
 * Task verified signal — AI agent confirms the task output meets criteria.
 * Must be emitted before the matching `TaskCompleteSignal`.
 */
export interface TaskVerifiedSignal {
  readonly type: 'task-verified';
  readonly output: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Task blocked signal — AI agent cannot proceed. The harness pauses
 * execution for this task and records the reason in `progress.md`.
 */
export interface TaskBlockedSignal {
  readonly type: 'task-blocked';
  readonly reason: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Note signal — informational message from the AI agent. The harness
 * appends it to `progress.md` as a free-form note.
 */
export interface NoteSignal {
  readonly type: 'note';
  readonly text: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Check-script discovery signal — emitted by a one-shot setup AI session
 * (`project add` / `project repo add`). Carries the raw shell command the
 * AI proposes as the verification gate. Setup-time only — no durable
 * handler. The caller consumes the signal inline as an editable default;
 * an empty/missing signal means the AI declined to propose one.
 */
export interface CheckScriptDiscoverySignal {
  readonly type: 'check-script-discovery';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * AGENTS.md proposal signal — emitted by a one-shot setup AI session
 * (`project onboard`). Carries the full proposed body for the
 * provider-native project context file (`CLAUDE.md` for Claude,
 * `.github/copilot-instructions.md` for Copilot).
 *
 * The wire tag is still `<agents-md>` (preserved for backwards
 * compatibility with the cross-tool spec), even though the file the
 * harness writes is provider-native — no symlinks, no pointer files.
 */
export interface AgentsMdProposalSignal {
  readonly type: 'agents-md-proposal';
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Setup-script proposal signal — emitted by `project onboard`. One shell
 * command the harness can run to install dependencies / prepare the repo
 * for an agentic session (e.g. `pnpm install`).
 *
 * Setup-time only — no durable handler. The caller consumes the signal
 * inline as an editable default during interview-mode review.
 *
 * Hostile shapes (pipe-to-shell, `curl … | sh`, `eval`, `rm -rf`) are
 * dropped at the parser boundary so an empty/missing signal is the
 * canonical "no proposal" state.
 */
export interface SetupScriptSignal {
  readonly type: 'setup-script';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Verify-script proposal signal — emitted by `project onboard`. One shell
 * command chain the harness can run as the post-task gate
 * (`pnpm typecheck && pnpm lint && pnpm test` and friends).
 *
 * Same security denylist as {@link SetupScriptSignal}. Empty/missing means
 * the AI declined to propose a gate — the caller falls through to manual
 * input rather than seeding an exec-able default.
 */
export interface VerifyScriptSignal {
  readonly type: 'verify-script';
  readonly command: string;
  readonly timestamp: IsoTimestamp;
}

/**
 * Skill-suggestions signal — emitted by `project onboard`. Zero or more
 * short kebab-case skill names the AI proposes linking into the agentic
 * working directory (e.g. `react-patterns`, `nextjs-app-router`).
 *
 * The harness presents the list to the user during interview-mode review
 * and links the accepted subset via the skills linker. Empty `names` is
 * the canonical "no suggestions" state — the prompt template optionally
 * omits the tag entirely in that case.
 */
export interface SkillSuggestionsSignal {
  readonly type: 'skill-suggestions';
  readonly names: readonly string[];
  readonly timestamp: IsoTimestamp;
}

/**
 * Discriminated union of every harness signal type. Narrows by the `type`
 * tag; exhaustive `switch` statements should close with
 * `const _exhaustive: never = signal` so adding a variant is a compile
 * error at every consumer until handled.
 */
export type HarnessSignal =
  | ProgressSignal
  | EvaluationSignal
  | TaskCompleteSignal
  | TaskVerifiedSignal
  | TaskBlockedSignal
  | NoteSignal
  | CheckScriptDiscoverySignal
  | AgentsMdProposalSignal
  | SetupScriptSignal
  | VerifyScriptSignal
  | SkillSuggestionsSignal;
