import { join } from 'node:path';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createIdeateFlow } from '@src/application/flows/ideate/flow.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

export const launchIdeate = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const {
    deps,
    snapshot,
    extras,
    settings,
    interactiveAi,
    skillsAdapter,
    skillSource,
    cwd,
    bridge,
    sessionId,
    effort,
  } = ctx;
  const missing = await checkCli('ideate', settings);
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };
  const titleAns = await deps.interactive.askText('Idea title (short)');
  if (!titleAns.ok) return { ok: false, reason: titleAns.error.message };
  const bodyAns = await deps.interactive.askText('Idea description (paste or type)');
  if (!bodyAns.ok) return { ok: false, reason: bodyAns.error.message };
  const ideateRoot = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'ideate')
  );
  if (!ideateRoot.ok) return { ok: false, reason: ideateRoot.error.message };
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
    },
    {
      sprintId: snapshot.sprint.id,
      projectId: snapshot.project.id,
      ideaTitle: titleAns.value,
      ideaText: bodyAns.value,
      cwd,
      providerId: settings.ai.ideate.provider,
      model: extras.modelOverride ?? settings.ai.ideate.model,
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
