import { join } from 'node:path';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createIdeateFlow } from '@src/application/flows/ideate/flow.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import type { PlanCheckFinding } from '@src/business/sprint/check-plan.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import { buildFindingsBlock, renderReviewTask, toPlanReviewTasks } from '@src/application/ui/shared/launch/plan.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

/**
 * Ideate's approval prompt. `ScrollableMessage` treats everything before the first blank line as
 * the pinned header, so the critic findings and the approve question lead (always on screen), then
 * the approved requirements and the task list scroll in the body. Pure so the composition is
 * unit-testable.
 *
 * @public
 */
export const buildIdeateReviewMessage = (
  requirements: string,
  tasks: ReturnType<typeof toPlanReviewTasks>,
  findings: readonly PlanCheckFinding[] = []
): string => {
  const findingsBlock = buildFindingsBlock(findings).trimEnd();
  const question = `Approve ideate? ${String(tasks.length)} task(s)`;
  const header = findingsBlock.length > 0 ? `${findingsBlock}\n${question}` : question;
  const summary = tasks.map((t, i) => renderReviewTask(t, i)).join('\n\n');
  return `${header}\n\nRequirements:\n${requirements.trim()}\n\nTasks are shown in dependency-resolved execution order.\n\n${summary}`;
};

export const launchIdeate = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, interactiveAi, skillsAdapter, skillSource, cwd, bridge, sessionId, effort } = ctx;
  const missing = await checkCli('ideate', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };
  const titleAns = await deps.interactive.askText('Idea title (short)');
  if (!titleAns.ok) return { ok: false, reason: titleAns.error.message };
  const bodyAns = await deps.interactive.askText('Idea description (paste or type)');
  if (!bodyAns.ok) return { ok: false, reason: bodyAns.error.message };
  // Subpath of the canonical `<id>--<slug>/` sprint dir, direct-built from the sprint entity.
  const ideateRoot = AbsolutePath.parse(
    join(buildSprintDir(deps.storage.dataRoot, snapshot.sprint.id, snapshot.sprint.slug), 'ideate')
  );
  if (!ideateRoot.ok) return { ok: false, reason: ideateRoot.error.message };
  // HITL approval — cancel = reject; the chain then leaves the sprint unchanged.
  const reviewBeforeApprove = async (
    requirements: string,
    proposedTasks: readonly TodoTask[],
    findings: readonly PlanCheckFinding[]
  ): Promise<{ readonly accept: boolean }> => {
    const message = buildIdeateReviewMessage(
      requirements,
      toPlanReviewTasks(proposedTasks, snapshot.project?.repositories ?? []),
      findings
    );
    const answered = await deps.interactive.askConfirm({ message });
    return { accept: answered.ok && answered.value };
  };
  const element: Element<IdeateCtx> = createIdeateFlow(
    {
      sprintRepo: deps.app.sprintRepo,
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
      ideaTitle: titleAns.value,
      ideaText: bodyAns.value,
      cwd,
      providerId: settings.ai.ideate.provider,
      model: settings.ai.ideate.model,
      maxAttempts: settings.harness.maxAttempts,
      memoryRoot: deps.storage.memoryRoot,
      ...(effort !== undefined ? { effort } : {}),
      ideateRoot: ideateRoot.value,
    }
  );
  const runner = createRunner<IdeateCtx>({
    id: sessionId(),
    element,
    initialCtx: {
      sprintId: snapshot.sprint.id,
      projectId: snapshot.project.id,
      ideaTitle: titleAns.value,
      ideaText: bodyAns.value,
      cwd,
    },
  });
  return { ok: true, runner: bridge(runner) as Runner<unknown>, title: `Ideate — ${snapshot.sprint.name}` };
};
