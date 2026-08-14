import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { loadSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/load-execution.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { buildPlanPrompt } from '@src/integration/ai/prompts/plan/definition.ts';
import { readCappedSprintProgress } from '@src/application/flows/_shared/progress/read-sprint-progress.ts';
import { composePriorLearnings } from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';
import { loadCandidateLearnings } from '@src/application/flows/_shared/memory/load-candidate-learnings.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { planOutputContract } from '@src/application/flows/plan/leaves/plan.contract.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import type { PlanDeps } from '@src/application/flows/plan/deps.ts';
import { callPlannerInteractiveLeaf } from '@src/application/flows/plan/leaves/call-planner-interactive.ts';
import { checkPlanLeaf } from '@src/application/flows/plan/leaves/check-plan.ts';
import { applyPlanLeaf } from '@src/application/flows/plan/leaves/apply-plan.ts';
import { aiUnitEpilogue, aiUnitPrelude } from '@src/application/flows/_shared/ai-unit-segment.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

export interface CreatePlanFlowOpts {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  /**
   * Repo roots mounted as equal `--add-dir` sources so the planner can navigate every repo on
   * a multi-repo project without per-file approval prompts. Caller (the launcher) passes
   * `project.repositories.map((r) => r.path)`. No repo enjoys cwd privilege — the session's
   * cwd is the per-sprint plan unit root, so no repo's `CLAUDE.md` / agents / `.mcp.json`
   * auto-loads, and the planner treats every repo symmetrically.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  /** Provider id used to attribute the per-run spawn in its `meta.json` sidecar. */
  readonly providerId: string;
  /** Configured model — `settings.ai.plan.model`. */
  readonly model: string;
  /** Resolved effort / reasoning level for the plan chain — optional. */
  readonly effort?: string;
  /**
   * Default per-task attempt cap (`settings.harness.maxAttempts`) stamped onto every planned
   * task so the gen-eval loop actually bounds attempts at execute time.
   */
  readonly maxAttempts: number;
  /** Per-sprint root: `<sprintDir>/plan/`. Per-run subfolder created at execute time. */
  readonly planRoot: AbsolutePath;
  /** Optional run slug. Defaults to `'session-<timestamp>'`. */
  readonly runSlug?: string;
  /**
   * Root of the per-project procedural-memory tree (`<dataRoot>/memory/`). When supplied, the
   * planner prompt is seeded with this project's not-yet-promoted learnings + decisions so the
   * planner scopes tasks and picks verification commands against earned repo facts rather than
   * blind (spec quality dominates generation quality). Optional: when omitted the ledger read is
   * skipped and the `<prior_learnings>` block collapses — the launcher passes
   * `deps.storage.memoryRoot`, mirroring the implement flow.
   */
  readonly memoryRoot?: AbsolutePath;
}

/**
 * Build the plan chain. Plan is **always interactive** — the user is in the loop for
 * implementation decisions; the AI writes a JSON task array to disk and the harness reads
 * it back.
 *
 *   sequential('plan', [
 *     load-and-assert-sprint(['draft']),
 *     load-project,
 *     load-sprint-execution,
 *     load-tasks,                       // existing tasks (replan support)
 *     build-plan-unit,                  // mkdir <sprintDir>/plan/<run-slug>/
 *     render-prompt-to-file,            // <unit-root>/prompt.md
 *     install-skills,                   // copy the plan flow's skills into the unit root
 *     stamp-meta-plan,                  // <unit-root>/meta.json — provider/model attribution
 *     call-planner-interactive,         // hand TTY → reads <unit-root>/signals.json → ctx.proposedTasks
 *     uninstall-skills,                 // remove them again
 *     check-plan,                       // zero-token deterministic critic → ctx.planCheck (advisory)
 *     apply-plan,                       // HITL gate (findings in hand) → planSprint(draft → planned)
 *     save-tasks,
 *     save-sprint,                      // sprint.status = 'planned'
 *   ])
 *
 * `check-plan` + `apply-plan` sit AFTER `uninstall-skills` so the skills sandbox is torn down
 * before a potentially long human pause at the approval gate.
 *
 * Persistence order: tasks first, then sprint. The sprint's `planned` status is the harness's
 * "tasks are ready" signal — saving it last means a crash mid-save leaves the sprint as
 * `draft` even if the tasks already landed; the next plan run is idempotent.
 */
export const createPlanFlow = (deps: PlanDeps, opts: CreatePlanFlowOpts): Element<PlanCtx> => {
  const slug = opts.runSlug ?? `session-${String(Date.now())}`;

  const unitOpts = {
    unitName: 'plan',
    flowId: 'plan' as const,
    parent: () => opts.planRoot,
    slug: () => slug,
    buildPrompt: async (ctx: PlanCtx) => {
      const renderLeafName = 'render-prompt-to-file';
      const renderState = 'pre-render-prompt';
      const sprint = assertCtxField(ctx, 'sprint', renderLeafName, renderState);
      const project = assertCtxField(ctx, 'project', renderLeafName, renderState);
      const currentUnitRoot = assertCtxField(ctx, 'currentUnitRoot', renderLeafName, renderState);
      const priorProgress = await readCappedSprintProgress(opts.planRoot, opts.model);
      // Cross-sprint procedural memory (read side). The plan session mounts every project repo
      // as an equal `--add-dir` source with no primary repo, so relevance is weighted by
      // recency only (empty context) rather than biasing toward any single repo. A missing
      // ledger resolves to an empty list, so the block degrades cleanly.
      const priorLearnings =
        opts.memoryRoot === undefined
          ? ''
          : composePriorLearnings(await loadCandidateLearnings(opts.memoryRoot, opts.projectId, deps.logger), {});
      return buildPlanPrompt(deps.templateLoader, {
        sprint,
        project,
        outputContractSection: renderContractSectionFor(planOutputContract, currentUnitRoot),
        priorProgress,
        priorLearnings,
        ...(ctx.tasks !== undefined && ctx.tasks.length > 0 ? { existingTasks: ctx.tasks } : {}),
      });
    },
    providerId: opts.providerId,
    model: opts.model,
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  } satisfies Parameters<typeof aiUnitPrelude<PlanCtx>>[1];

  return sequential<PlanCtx>('plan', [
    loadAndAssertSprintSubChain<PlanCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    loadProjectLeaf<PlanCtx>({ projectRepo: deps.projectRepo }),
    loadSprintExecutionLeaf<PlanCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
    loadTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
    ...aiUnitPrelude<PlanCtx>(
      {
        writeFile: deps.writeFile,
        skillsAdapter: deps.skillsAdapter,
        skillSource: deps.skillSource,
        clock: deps.clock,
      },
      unitOpts
    ),
    callPlannerInteractiveLeaf({
      interactiveAi: deps.interactiveAi,
      runInTerminal: deps.runInTerminal,
      logger: deps.logger,
      writeFile: deps.writeFile,
      eventBus: deps.eventBus,
      model: opts.model,
      maxAttempts: opts.maxAttempts,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.additionalRoots !== undefined && opts.additionalRoots.length > 0
        ? { additionalRoots: opts.additionalRoots }
        : {}),
    }),
    ...aiUnitEpilogue<PlanCtx>({ skillsAdapter: deps.skillsAdapter }, unitOpts),
    checkPlanLeaf({ logger: deps.logger }),
    applyPlanLeaf({
      logger: deps.logger,
      clock: deps.clock,
      ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
    }),
    saveTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
    saveSprintLeaf<PlanCtx>({ sprintRepo: deps.sprintRepo }),
  ]);
};
