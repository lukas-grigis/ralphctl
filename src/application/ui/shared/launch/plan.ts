import { join } from 'node:path';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import { type PlanCheckFinding, renderPlanCheckFinding, severityOfFinding } from '@src/business/sprint/check-plan.ts';
import type { DraftSprint } from '@src/domain/entity/sprint.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createPlanFlow } from '@src/application/flows/plan/flow.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

/** One verification criterion as shown at the approval gate. */
export interface PlanReviewCriterion {
  readonly id: string;
  readonly check: 'auto' | 'manual';
  readonly assertion: string;
  readonly command?: string;
}

/**
 * A task as surfaced to the human approval gate — every field the operator is about to import.
 * All but `name` are optional so a partial task still renders.
 */
export interface PlanReviewTask {
  readonly name: string;
  readonly description?: string;
  readonly ticketRef?: string;
  /** Display name of the repository the task runs in. */
  readonly repository?: string;
  /** Names of prerequisite tasks (already resolved from ids). */
  readonly dependsOn?: readonly string[];
  readonly steps?: readonly string[];
  readonly verificationCriteria?: readonly PlanReviewCriterion[];
}

/**
 * Project the planner's tasks onto the review shape: repository id → repo name, dependency ids →
 * the names of the tasks they point at (falling back to the raw id when the target is not in the
 * proposal), external refs → the ticket ref.
 *
 * @public
 */
export const toPlanReviewTasks = (
  tasks: readonly TodoTask[],
  repositories: readonly Repository[]
): readonly PlanReviewTask[] => {
  const nameById = new Map<string, string>(tasks.map((t) => [t.id as string, t.name]));
  return tasks.map((t) => {
    const repo = repositories.find((r) => r.id === t.repositoryId);
    return {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.externalRefs !== undefined && t.externalRefs.length > 0 ? { ticketRef: t.externalRefs.join(', ') } : {}),
      repository: repo?.name ?? (t.repositoryId as string),
      dependsOn: t.dependsOn.map((id) => nameById.get(id as string) ?? (id as string)),
      steps: t.steps,
      verificationCriteria: t.verificationCriteria,
    };
  });
};

/** Most finding lines rendered inline before the prompt body stops being readable in an Ink confirm. */
const MAX_RENDERED_FINDINGS = 10;

/**
 * Errors first, then warnings, each in critic order; capped so a pathological plan cannot push
 * the task list off screen. Returns `''` when the critic found nothing, so the message is
 * byte-identical to the pre-critic wording on a clean plan.
 */
const buildFindingsBlock = (findings: readonly PlanCheckFinding[]): string => {
  if (findings.length === 0) return '';
  const ordered = [
    ...findings.filter((f) => severityOfFinding(f) === 'error'),
    ...findings.filter((f) => severityOfFinding(f) === 'warning'),
  ];
  const shown = ordered.slice(0, MAX_RENDERED_FINDINGS).map((f) => `  ${renderPlanCheckFinding(f)}`);
  const hidden = ordered.length - shown.length;
  const tail = hidden > 0 ? [`  … and ${String(hidden)} more`] : [];
  return `Plan check found ${String(ordered.length)} issue(s) — advisory, you decide:\n${[...shown, ...tail].join('\n')}\n\n`;
};

const renderCriteria = (criteria: readonly PlanReviewCriterion[]): readonly string[] => {
  if (criteria.length === 0) return [];
  const lines = ['   verification:'];
  for (const c of criteria) {
    lines.push(`     ${c.id} [${c.check}] ${c.assertion}`);
    if (c.command !== undefined && c.command.length > 0) lines.push(`         $ ${c.command}`);
  }
  return lines;
};

const renderReviewTask = (t: PlanReviewTask, index: number): string => {
  const lines = [`${String(index + 1)}. ${t.name}${t.ticketRef !== undefined ? `  [${t.ticketRef}]` : ''}`];
  if (t.repository !== undefined && t.repository.length > 0) lines.push(`   repository: ${t.repository}`);
  if (t.dependsOn !== undefined && t.dependsOn.length > 0) lines.push(`   depends on: ${t.dependsOn.join(', ')}`);
  if (t.description !== undefined && t.description.length > 0) {
    for (const l of t.description.split('\n')) lines.push(`   ${l}`);
  }
  if (t.steps !== undefined && t.steps.length > 0) {
    lines.push('   steps:');
    t.steps.forEach((step, si) => lines.push(`     ${String(si + 1)}. ${step}`));
  }
  lines.push(...renderCriteria(t.verificationCriteria ?? []));
  return lines.join('\n');
};

/**
 * Render the human-facing plan-approval prompt body (audit §5 human-gate). The parser has
 * already dependency-resolved the task list before it reaches this gate, so the order shown is
 * the execution order — the note makes that visible to the operator rather than letting the
 * reorder happen as a silent topo-sort. Per-task reorder editing is out of scope.
 *
 * `findings` are the deterministic plan critic's output. They are rendered ABOVE the task list so
 * the operator reads them before deciding, and they are purely advisory — nothing here rejects on
 * the operator's behalf.
 *
 * Pure — extracted so the rendered message (including the dependency-order note) is unit-testable
 * without constructing a full launch context.
 *
 * @public
 */
export const buildPlanReviewMessage = (
  proposedTasks: readonly PlanReviewTask[],
  findings: readonly PlanCheckFinding[] = []
): string => {
  const summary = proposedTasks.map((t, i) => renderReviewTask(t, i)).join('\n\n');
  return `${buildFindingsBlock(findings)}Approve plan? ${String(proposedTasks.length)} task(s):\n\nTasks are shown in dependency-resolved execution order.\n\n${summary}`;
};

export const launchPlan = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, interactiveAi, skillsAdapter, skillSource, bridge, sessionId, effort } = ctx;
  const missing = await checkCli('plan', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // No `cwd` pre-flight: plan's AI session is rooted at the per-sprint plan unit root
  // (`<sprintDir>/plan/<run-slug>/`), and every project repository is mounted as an equal
  // `--add-dir` source. If `repositories` is empty the chain surfaces a clearer error from
  // inside (e.g. the planner producing a `projectPath` mismatch) than an opaque pre-flight reject.
  // Subpath of the canonical `<id>--<slug>/` sprint dir, direct-built from the sprint entity.
  const planRoot = AbsolutePath.parse(
    join(buildSprintDir(deps.storage.dataRoot, snapshot.sprint.id, snapshot.sprint.slug), 'plan')
  );
  if (!planRoot.ok) return { ok: false, reason: planRoot.error.message };
  // HITL approval — same shape as refine: the AI's proposed task list is summarised, the user
  // accepts/rejects via an Ink confirm prompt. Cancel = reject; downstream save-tasks /
  // save-sprint then no-op against the unchanged draft sprint.
  const reviewBeforeApprove = async (
    proposedTasks: readonly TodoTask[],
    _sprint: DraftSprint,
    findings: readonly PlanCheckFinding[]
  ): Promise<{ readonly accept: boolean }> => {
    const message = buildPlanReviewMessage(
      toPlanReviewTasks(proposedTasks, snapshot.project?.repositories ?? []),
      findings
    );
    const answered = await deps.interactive.askConfirm({ message });
    if (!answered.ok) return { accept: false };
    return { accept: answered.value };
  };
  const element: Element<PlanCtx> = createPlanFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      sprintExecutionRepo: deps.app.sprintExecutionRepo,
      projectRepo: deps.app.projectRepo,
      taskRepo: deps.app.taskRepo,
      interactiveAi,
      templateLoader: deps.app.templateLoader,
      writeFile: deps.app.writeFile,
      runInTerminal: deps.runInTerminal,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      skillsAdapter,
      skillSource,
      reviewBeforeApprove,
    },
    {
      sprintId: snapshot.sprint.id,
      projectId: snapshot.project.id,
      // Mount every repo on the project as an equal `--add-dir` source so the planner can
      // navigate across them without per-file approval prompts. No repo enjoys cwd privilege —
      // the session's cwd is the per-sprint plan unit root.
      additionalRoots: snapshot.project.repositories.map((r) => r.path),
      providerId: settings.ai.plan.provider,
      model: settings.ai.plan.model,
      maxAttempts: settings.harness.maxAttempts,
      memoryRoot: deps.storage.memoryRoot,
      ...(effort !== undefined ? { effort } : {}),
      planRoot: planRoot.value,
    }
  );
  const runner = createRunner<PlanCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id, projectId: snapshot.project.id },
  });
  return { ok: true, runner: bridge(runner) as Runner<unknown>, title: `Plan — ${snapshot.sprint.name}` };
};
