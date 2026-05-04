/**
 * `SessionFolderBuilderPort` — materialises per-unit sandbox folders that
 * AI sessions spawn inside. One folder per unit (per-ticket for
 * refine/ideate, single per-sprint for plan, per-task for execution
 * evaluation).
 *
 * Each unit folder is a self-contained "contract pack" the AI reads:
 *  - A provider-native context file at the unit root (`CLAUDE.md` for
 *    Claude, `.github/copilot-instructions.md` for Copilot) that orients
 *    the agent on what this folder is for.
 *  - Phase-specific input artefacts (ticket, refined requirements, prior
 *    evaluations, dimension definitions, …) the AI reads to do its job.
 *  - For Copilot, read-only mirrors of the affected repositories — Copilot
 *    has no `--add-dir` equivalent, so the harness pre-mirrors the trees
 *    into the sandbox. For Claude, the affected-repo paths are returned in
 *    `addDirs` for the caller to forward as `--add-dir` flags.
 *
 * **Cleanup policy:** the adapter NEVER auto-deletes a folder. It only
 * creates / overwrites. `linkSkills`/`unlinkSkills` continues to manage
 * `.claude/skills/` inside each folder at chain run time.
 *
 * **Refresh semantics:** `refreshExecutionUnit` overwrites only the
 * volatile per-task files (`task.md`, `tasks.md`, `tasks.json`,
 * `project-context.md`, `evaluations/`). Static files written by the
 * initial `buildExecutionUnit` (`requirements/`, `dimensions.md`,
 * the root context file) are left untouched.
 */
import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

export interface RefinementUnitPaths {
  /** Absolute path to the unit root — pass as the AI session's `cwd`. */
  readonly root: AbsolutePath;
  /** `<root>/session.md` — write start/finish records here. */
  readonly sessionMdPath: AbsolutePath;
  /** `<root>/ticket.md` — pre-rendered ticket input for the AI. */
  readonly ticketMdPath: AbsolutePath;
  /**
   * `<root>/requirements.json` — where the AI is told to write its raw
   * output. JSON because the AI emits a `[{ ref, requirements }]` array
   * the harness parses; markdown extension would mislabel the format.
   */
  readonly requirementsJsonPath: AbsolutePath;
}

export interface IdeationUnitPaths {
  readonly root: AbsolutePath;
  readonly sessionMdPath: AbsolutePath;
  readonly ticketMdPath: AbsolutePath;
  /** `<root>/output.json` — where the AI writes its proposed sprint output. */
  readonly outputJsonPath: AbsolutePath;
}

export interface PlanningFolderPaths {
  readonly root: AbsolutePath;
  /** `<root>/session.md` — single per-sprint session record. */
  readonly sessionMdPath: AbsolutePath;
  /** `<root>/tasks.json` — raw AI-written tasks (later promoted to canonical). */
  readonly rawTasksJsonPath: AbsolutePath;
  /**
   * Affected-repo paths to forward as `--add-dir` (Claude only). Empty for
   * Copilot — the adapter mirrors the repos into `<root>/repos/<basename>/`
   * instead, since Copilot has no equivalent flag.
   */
  readonly addDirs: readonly AbsolutePath[];
}

export interface ExecutionUnitPaths {
  readonly root: AbsolutePath;
  /** Claude: `[root]` so the evaluator can see the contract pack. Copilot: `[]`. */
  readonly addDirs: readonly AbsolutePath[];
  /**
   * Working directory the evaluator session should spawn under. Claude:
   * the task's `projectPath` (the evaluator runs read-only in the real
   * repo). Copilot: the unit root, since the repo is mirrored under
   * `<root>/repo/`.
   */
  readonly sessionCwd: AbsolutePath;
  /** `<root>/evaluation.md` — durable evaluator critique sink (overwritten per round). */
  readonly evaluationMdPath: AbsolutePath;
}

export interface SessionFolderBuilderPort {
  /**
   * Build a per-ticket refinement unit folder. Writes `ticket.md` and the
   * provider-native context file. Skills are linked separately by the
   * `link-skills` leaf. No repo access (refine is implementation-agnostic).
   */
  buildRefinementUnit(input: {
    readonly sprint: Sprint;
    readonly ticket: Ticket;
    readonly aiProvider: AiProvider;
  }): Promise<Result<RefinementUnitPaths, DomainError>>;

  /**
   * Build a per-ticket ideation unit folder. Symmetric to refinement;
   * the AI is told to write its proposal at `<root>/output.json`.
   */
  buildIdeationUnit(input: {
    readonly sprint: Sprint;
    readonly ticket: Ticket;
    readonly aiProvider: AiProvider;
  }): Promise<Result<IdeationUnitPaths, DomainError>>;

  /**
   * Build the single per-sprint planning folder. Writes the
   * provider-native context file and pre-stages a `repos/` mirror for
   * Copilot. The AI is told to write its raw `tasks.json` at the unit
   * root; the chain then promotes it to the canonical sprint location.
   */
  buildPlanningFolder(input: {
    readonly sprint: Sprint;
    readonly aiProvider: AiProvider;
  }): Promise<Result<PlanningFolderPaths, DomainError>>;

  /**
   * Build a per-task execution unit folder. Writes both static files
   * (`requirements/`, `dimensions.md`, the root context file) and the
   * volatile per-task files (`task.md`, `tasks.md`, `tasks.json`,
   * `project-context.md`, `evaluations/`). For Copilot, mirrors the
   * task's `projectPath` into `<root>/repo/`.
   */
  buildExecutionUnit(input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
  }): Promise<Result<ExecutionUnitPaths, DomainError>>;

  /**
   * Refresh the volatile execution-unit files between evaluator rounds
   * without touching static artefacts. Cheap to call once per task
   * settlement inside the per-task chain.
   */
  refreshExecutionUnit(input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
  }): Promise<Result<void, DomainError>>;
}
