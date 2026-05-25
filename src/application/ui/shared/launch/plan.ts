import { join } from 'node:path';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createPlanFlow } from '@src/application/flows/plan/flow.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

export const launchPlan = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, extras, settings, interactiveAi, skillsAdapter, skillSource, bridge, sessionId, effort } =
    ctx;
  const missing = await checkCli('plan', settings);
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // No `cwd` pre-flight: plan's AI session is rooted at the per-sprint plan unit root
  // (`<sprintDir>/plan/<run-slug>/`), and every project repository is mounted as an equal
  // `--add-dir` source. If `repositories` is empty the chain surfaces a clearer error from
  // inside (e.g. the planner producing a `projectPath` mismatch) than an opaque pre-flight reject.
  const planRoot = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'plan')
  );
  if (!planRoot.ok) return { ok: false, reason: planRoot.error.message };
  // HITL approval — same shape as refine: the AI's proposed task list is summarised, the user
  // accepts/rejects via an Ink confirm prompt. Cancel = reject; downstream save-tasks /
  // save-sprint then no-op against the unchanged draft sprint.
  const reviewBeforeApprove = async (
    proposedTasks: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly ticketRef?: string }>
  ): Promise<{ readonly accept: boolean }> => {
    const summary = proposedTasks
      .map((t, i) => {
        const head = `${String(i + 1)}. ${t.name}${t.ticketRef !== undefined ? `  [${t.ticketRef}]` : ''}`;
        const body = t.description !== undefined && t.description.length > 0 ? `\n   ${t.description}` : '';
        return `${head}${body}`;
      })
      .join('\n');
    const message = `Approve plan? ${String(proposedTasks.length)} task(s):\n\n${summary}`;
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
      model: extras.modelOverride ?? settings.ai.plan.model,
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
