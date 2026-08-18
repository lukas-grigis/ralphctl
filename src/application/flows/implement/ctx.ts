import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AttemptWarning, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationSignal, LearningEntry } from '@src/domain/signal.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import type { ProposedCommitMessage } from '@src/business/task/run-generator-turn.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { ReproductionArtifact } from '@src/application/flows/implement/leaves/reproduce.ts';
import type { BestOfNCandidateRecord } from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';

export type { GenEvalExit, RunTaskVerdict };

/**
 * Context flowing through the implement chain. Optional fields populate as upstream leaves run:
 *  - `sprint` — set by `loadSprintLeaf`.
 *  - `execution` — set by `loadSprintExecutionLeaf`.
 *  - `tasks` — set by `loadTasksLeaf`; mutated by per-task leaves so persistence carries the
 *    latest transitions.
 *  - `progressFile` — absolute path to `<sprintDir>/progress.md`, supplied via `opts.progressFile`
 *    (derived by the launcher); appended to by the `progress-journal` leaves.
 *  - `currentTaskId` / `currentTask` — written by `start-attempt` for the in-flight task; consumed
 *    by gen-eval leaves, `commit-task`, and `settle-attempt`.
 *  - `genEvalTurn` — turn counter inside the gen-eval loop, incremented by `generator` leaf.
 *  - `lastEvaluation` — latest evaluator signal; used by the evaluator leaf for plateau detection.
 *  - `lastExitKind` — set when a gen-eval terminal condition is reached (by `generator` /
 *    `evaluator`) or by `finalize-gen-eval` (budget-exhausted).
 *  - `lastWarning` — derived from gen-eval exit / `lastVerifyResult`; consumed by `settle-attempt`.
 *  - `lastVerdict` — passed/failed/malformed; set by `finalize-gen-eval`.
 *  - `lastBlockReason` — set by `generator` on `self-blocked`; drives `markTaskBlocked`.
 *  - `lastVerifyResult` — set by `post-task-verify`.
 *  - `lastCommitSha` — set by `commit-task` if the tree was dirty and the commit landed.
 *  - `proposedCommitMessage` — generator-emitted `<commit-message>` signal from the latest
 *    turn that produced one. Consumed by `commit-task`'s default message factory. Carries
 *    across turns: when the loop iterates, the latest non-undefined value wins so the final
 *    commit reflects the final accepted state of the work.
 *  - `expectedBranch` — branch name `resolveBranchLeaf` checked out on the working tree.
 *    Stamped after persistence so per-task `branchPreflightLeaf` can short-circuit when the
 *    current ref doesn't match (e.g. the user manually `git checkout`-ed mid-run).
 */
export interface ImplementCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint | undefined;
  readonly execution?: SprintExecution | undefined;
  readonly tasks?: readonly Task[] | undefined;
  readonly progressFile?: AbsolutePath | undefined;
  /**
   * Per-task audit workspace root — `<sprintDir>/implement/<task-id>/`. Set by
   * `buildTaskWorkspaceLeaf` at the start of every per-task sub-chain. The generator/evaluator
   * leaves use this to write `rounds/<N>/…/session.md` and `signals.json` after each turn.
   */
  readonly taskWorkspaceRoot?: AbsolutePath | undefined;
  readonly currentTaskId?: TaskId | undefined;
  readonly currentTask?: Task | undefined;
  readonly genEvalTurn?: number | undefined;
  /**
   * On-disk round folder index for the current gen-eval turn — `rounds/<N>/`. Set by the
   * generator leaf (`max(existing-rounds-on-disk) + 1`) and read by the evaluator leaf so both
   * roles write under the same `<N>`. On a fresh task this equals `genEvalTurn`; on a resumed
   * task it picks up after the highest round already on disk so prior rounds aren't overwritten.
   */
  readonly currentRoundNum?: number | undefined;
  readonly lastEvaluation?: EvaluationSignal | undefined;
  /**
   * Append-only per-task history of completed evaluator turns — fed into the plateau
   * predicate by the evaluator leaf so a configurable window of consecutive turns (see
   * `settings.harness.plateauThreshold`) can be compared, not just the immediate prior one.
   * Reset implicitly per task: a fresh `currentTask` starts with an empty array.
   */
  readonly plateauHistory?: readonly PlateauTurnRecord[] | undefined;
  /**
   * Per-turn distribution of generator-emitted signal kinds (`decision` / `change` / `learning` /
   * `note`) for the turn just completed — only kinds with a non-zero count are present. Stamped by
   * the generator leaf on every turn and consumed by the entropy-plateau heuristic in the
   * gen-eval loop (`entropy-check-<id>`) as a SIGNAL-KIND-DISTRIBUTION proxy for action entropy:
   * the harness never sees the AI's raw tool-use, so the spread of reported signal kinds stands in
   * for "action diversity". Run-scoped to the CURRENT turn (overwritten every generator turn), so it
   * never accumulates across turns. A secondary/softer signal to the fingerprint-repetition guard.
   */
  readonly lastTurnActionCounts?: ReadonlyMap<string, number> | undefined;
  readonly lastExit?: GenEvalExit | undefined;
  readonly lastVerdict?: RunTaskVerdict | undefined;
  readonly lastBlockReason?: string | undefined;
  readonly lastWarning?: AttemptWarning | undefined;
  /**
   * Set true by `finalize-gen-eval-<taskId>` when the model-escalation policy stamped the
   * current task with `escalatedFromModel`/`escalatedToModel`. Read by
   * `settle-attempt-<taskId>` to fail the running attempt instead of marking the task done —
   * the next chain invocation then re-attempts the task with the escalated generator model.
   * Cleared by settle-attempt along with the rest of the per-task verdict state.
   */
  readonly lastShouldFailAttempt?: boolean | undefined;
  readonly lastVerifyResult?:
    | { readonly kind: 'skipped' }
    | { readonly kind: 'passed' }
    | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
    | undefined;
  /**
   * Outcome of the pre-task-verify leaf for the in-flight task — `'success' | 'failed' |
   * 'spawn-error' | 'skipped'`. Read by `post-task-verify` to compute attribution. Cleared
   * by `settle-attempt` along with the rest of the per-task verdict state.
   */
  readonly lastPreVerifyOutcome?: VerifyRunOutcome | undefined;
  /**
   * Outcome + cwd + gate coverage of the most recent post-task-verify run. Read by the NEXT
   * task's pre-task-verify leaf to decide whether the carried baseline can stand in for
   * re-running the script (short-circuits when `outcome === 'success'`, `coveredAllGates` is
   * `true`, the cwd matches, and the working tree is clean per `git status --porcelain`).
   * Survives `settle-attempt` — that leaf clears per-attempt fields but this field carries
   * across tasks. Undefined before the first post-task-verify of a sprint.
   *
   * `coveredAllGates` is what makes the carry sound under structured `verifyGates`: post-verify
   * runs only the gates the attempt's diff footprint touched, so its aggregate `'success'` means
   * "every EXECUTED gate passed", NOT "the tree is green". Carrying a diff-scoped green as a
   * whole-tree baseline would let the next task's pre-verify synthesize a green it never
   * measured — and a gate that was already red outside that footprint then reads as `regressed`
   * on the next task that touches it. An absent flag (a ctx from before this field existed)
   * counts as NOT covered: demote to running the real gate rather than assume coverage.
   */
  readonly priorPostVerifyOutcome?:
    { readonly cwd: AbsolutePath; readonly outcome: VerifyRunOutcome; readonly coveredAllGates?: boolean } | undefined;
  /**
   * Repository ids whose setup script SUCCEEDED during THIS launch's `setup-script-runner` leaf.
   * Distinct from `SprintExecution.setupRanAt` (which persists across launches/resumes): this
   * marker is run-scoped and lives only on ctx, so a prior launch's persisted success does NOT
   * appear here. Set by `setup-script-runner` (it appends a repo id only when the script ran
   * green in this invocation — NOT on the resume-skip path, where the success belongs to an
   * earlier launch). Read by the first `pre-task-verify` of the run (per repo) to seed a green
   * baseline without re-running the verify gate, when `harness.skipPreVerifyOnFreshSetup` is on
   * and the tree is clean. Survives the parallel-path `forkCtx` (run-scoped, like `execution`).
   * Undefined before setup runs / when no setup succeeded this launch.
   */
  readonly setupVerifiedRepoIdsThisRun?: readonly RepositoryId[] | undefined;
  readonly lastCommitSha?: string | undefined;
  readonly proposedCommitMessage?: ProposedCommitMessage | undefined;
  readonly expectedBranch?: string | undefined;
  /**
   * Captured Claude `session_id` from the most recent generator turn of the in-flight task.
   * Threaded into the next round's `implementSession({ resume })` so the generator continues
   * as ONE conversational thread across all gen-eval rounds for this task — instead of paying
   * Claude's full startup cost (cwd discovery, MCP server re-init, system-prompt reprocess)
   * on every spawn. Cleared by `start-attempt-<id>` when a new task begins so the next task
   * starts a fresh "developer."
   *
   * Read from `<workspaceRoot>/rounds/<N>/generator/session-id.txt` per the file-based provider
   * contract — the Claude adapter writes the file via `persistSessionIdFile` after every spawn.
   * Undefined on the first round of a task or when the prior spawn failed before reporting an id.
   */
  readonly priorGeneratorSessionId?: SessionId | undefined;
  /**
   * Captured Claude `session_id` from the most recent evaluator turn of the in-flight task.
   * Mirror of {@link priorGeneratorSessionId} for the reviewer thread. Generator and evaluator
   * are intentionally separate conversational threads: their roles, prompts, and tool budgets
   * differ, and mixing their transcripts via cross-role resume would confuse the model.
   */
  readonly priorEvaluatorSessionId?: SessionId | undefined;
  /**
   * Per-attempt decision accumulator — every `decision` signal the generator/evaluator emits
   * during the gen-eval loop is pushed onto this array by the leaves. Read by
   * `progress-journal-<taskId>` to render the `### Decisions` subsection of the journal
   * entry, then cleared on the same leaf so the next task starts with an empty accumulator.
   * Wave 7 (audit-[07]) replaces the on-disk `decisions.log` sink with this in-memory
   * aggregate.
   */
  readonly currentAttemptDecisions?: readonly string[] | undefined;
  /**
   * Per-attempt `change` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Read by `progress-journal-<taskId>` to render the `### Changes` subsection. Cleared by
   * the journal leaf after the attempt settles.
   */
  readonly currentAttemptChanges?: readonly string[] | undefined;
  /**
   * Per-attempt `learning` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Each entry is a structured {@link LearningEntry} (Insight + optional Context + optional
   * Applies-to). Read by `progress-journal-<taskId>` to render the `### Learnings` subsection
   * and by `append-learnings-<taskId>` to persist the procedural-memory ledger rows. Cleared
   * by the journal leaf after the attempt settles.
   */
  readonly currentAttemptLearnings?: readonly LearningEntry[] | undefined;
  /**
   * Per-attempt `note` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Read by `progress-journal-<taskId>` to render the `### Notes` subsection. Cleared by
   * the journal leaf after the attempt settles.
   */
  readonly currentAttemptNotes?: readonly string[] | undefined;
  /**
   * Per-attempt count of corrective `signals.json` nudges the GENERATOR needed this attempt
   * (see `validateSignalsFileWithCorrectiveRetry`). Nudges consume no turn/attempt budget by
   * design (near-miss recovery must not eat the real budget), so a persistently malformed AI can
   * burn `correctiveRetries × turns` hidden extra spawns that appear in no other operator-facing
   * counter — this field is the ONLY surface for them. Pure observability: never read by any
   * business decision. Accumulated across every turn of the attempt by the generator leaf, read
   * by `progress-journal-<taskId>` to render the outcome clause, then cleared alongside the other
   * per-attempt accumulators. Undefined until the first turn that needed a nudge.
   */
  readonly currentAttemptGeneratorNudges?: number | undefined;
  /** Evaluator mirror of {@link currentAttemptGeneratorNudges} — same lifecycle, same rationale. */
  readonly currentAttemptEvaluatorNudges?: number | undefined;
  /**
   * Per-attempt sum of the provider-reported PROMPT token counts across every gen-eval spawn of
   * this attempt (both roles). Accumulated by the generator / evaluator leaves from
   * `RoleTurnOutcome.usage`, read once by `settle-attempt-<taskId>` which persists it onto the
   * settling attempt, then cleared alongside the other per-attempt accumulators by
   * `progress-journal-<taskId>` (which runs AFTER settle). Undefined when no spawn of the attempt
   * reported token usage — the harness never substitutes a `0`.
   */
  readonly currentAttemptInputTokens?: number | undefined;
  /** Completion-side mirror of {@link currentAttemptInputTokens} — same lifecycle, same source. */
  readonly currentAttemptOutputTokens?: number | undefined;
  /**
   * Per-attempt sum of harness-measured AI wall-clock (ms) across the same spawns as
   * {@link currentAttemptInputTokens}. Excludes harness work between spawns, so it is NOT the
   * attempt's `finishedAt - startedAt`.
   */
  readonly currentAttemptDurationMs?: number | undefined;
  /**
   * Cross-sprint procedural memory loaded ONCE in the implement prologue (`load-prior-learnings`)
   * from this project's append-only learnings ledger (`<memoryRoot>/<projectId>/learnings.ndjson`),
   * filtered to the not-yet-promoted records (`promotedAt === null` — promoted ones already live in
   * the provider's native context file). Read by every per-task `generator` leaf and rendered as a
   * read-only "learnings from prior sprints" block in the FULL implement prompt (round 1 of a session
   * thread) so a sprint N+1 generator does not re-discover what sprint N already earned (principle 3).
   *
   * Run-scoped, like `execution` / `setupVerifiedRepoIdsThisRun`: it is loaded once before the task
   * waves and must survive both the parallel `forkCtx` (every branch reads the same memory) and the
   * `mergeImplementWave` fan-in. Undefined before the prologue loads / when the ledger is absent.
   */
  readonly priorLearnings?: readonly LearningRecord[] | undefined;
  /**
   * Validated reproduction artifact for the in-flight defect-shaped task — set once by the
   * guarded `reproduce-<taskId>` leaf that runs before the attempt loop (see `reproduce.ts`).
   * Undefined for a non-defect-shaped task (the guard skipped), or when the reproduce session
   * failed, produced no valid `reproduction` signal, or its claimed command did not actually
   * fail on the harness's own re-run — all of which degrade to today's behaviour rather than
   * blocking the task. Read by every generator/evaluator turn of this task's gen-eval loop (round
   * 1 and continuation prompts alike) to thread the `<reproduction>` prompt section; survives
   * across attempts of the SAME task (the reproduction test does not change between attempts) and
   * is never cleared by `settle-attempt`. Cleared unconditionally at the START of every task by
   * `clearReproductionArtifactLeaf` (see `reproduce.ts`) — without that reset a defect-shaped
   * task's artifact would otherwise leak into a later non-defect task of the same run.
   */
  readonly reproductionArtifact?: ReproductionArtifact | undefined;
  /**
   * Best-of-N candidate accumulator (arXiv 2604.16529) — populated by the candidate-sampling
   * loop that replaces round 1's generator phase inside a best-of-N-granted attempt (see
   * `leaves/best-of-n-candidate.ts` / `leaves/best-of-n.ts`). Each entry is one candidate
   * generator session's telemetry: whether it produced a diff, its verify outcome/attribution,
   * a content hash for dedup, and the mechanical summary text the judge tournament compares.
   * Grows one entry per loop iteration; read by `leaves/best-of-n-selection.ts` once sampling
   * finishes. Reset to `undefined` by `start-attempt` at the top of every attempt (mirrors
   * `plateauHistory`'s per-attempt lifecycle) — candidates never survive past the attempt that
   * sampled them, and a non-granted attempt never populates this field at all.
   */
  readonly bestOfNCandidates?: readonly BestOfNCandidateRecord[] | undefined;
  /**
   * Monotonic count of candidate-loop ITERATIONS attempted so far (successful or not) — the
   * candidate-slot index generator for `leaves/best-of-n-candidate.ts`. Deliberately separate
   * from `bestOfNCandidates.length` (which only counts SUCCESSFUL spawns): a self-blocked /
   * crashed / invalid-signals candidate still consumes a slot (and its own `candidates/<n>/`
   * directory + stash message) so the next iteration never re-tries the same index. Same
   * per-attempt lifecycle as `bestOfNCandidates` — reset by `start-attempt`.
   */
  readonly bestOfNSampledCount?: number | undefined;
  /**
   * 1-based turn counter for THIS attempt's own best-of-N composite (`best-of-n.ts`'s
   * `buildBestOfNGenEvalLoop`) — stamped once per turn, before either its round-1-substitute or
   * round-2+-generator guard evaluates, and untouched by both. Two jobs:
   *
   *  1. Replaces the disk-derived `currentRoundNum === 1` check the round-1-substitute guard used
   *     to gate on. `currentRoundNum` is claimed PER TASK (`max(rounds/<N>/ already on disk) + 1`
   *     across every attempt of the task), so on a real granted attempt — which never lands
   *     before attempt 3 (the escalation policy only grants at `nudgedAtTop`, itself downstream
   *     of a prior plateau + nudge) — it starts at 3 or higher and the substitute never fired.
   *     This field is attempt-scoped (reset by `start-attempt`, like `currentRoundNum` itself),
   *     so turn 1 of THIS composite is always `1` regardless of how many rounds prior attempts of
   *     the same task already wrote to disk.
   *  2. Gives `attempt-body.ts`'s outer `best-of-n-branch` / `normal-gen-eval-branch` guard pair a
   *     STABLE "did this attempt's best-of-N composite already run" signal. Both guards are
   *     evaluated independently, in sequence, by the surrounding `sequential` — the second one
   *     AFTER the whole composite (potentially several turns) has returned. `bestOfNSelectionLeaf`
   *     clears the transient `task.bestOfNGrantedCandidates` partway through that SAME composite
   *     (so a LATER attempt of the task doesn't re-trigger it), which would make the second guard
   *     misread "not granted" and ALSO run the normal loop if it re-derived the decision from that
   *     same mutable task field. Reading this field's definedness instead survives that mutation.
   *
   * Reset to `undefined` by `start-attempt` at the top of every attempt — mirrors `currentRoundNum`.
   */
  readonly bestOfNLoopTurn?: number | undefined;
  /**
   * Best-of-N summary for the attempt the selection cascade just closed out — how many candidates
   * were sampled, how many survived the execution-filter/dedupe stages, and which (1-based)
   * candidate index won (absent when zero survivors → no diff applied that round). Stamped by
   * `bestOfNSelectionLeaf` once selection finishes; read by `progress-journal-<taskId>` so the
   * `### Continuation state` block records that N sessions were spent even though the rest of the
   * attempt (verify runs, attribution, commit) looks like any other single-turn attempt. Reset to
   * `undefined` by `start-attempt` — mirrors `bestOfNCandidates`'s per-attempt lifecycle.
   */
  readonly bestOfNSummary?:
    { readonly candidatesSampled: number; readonly survivors: number; readonly winnerIndex?: number } | undefined;
}
