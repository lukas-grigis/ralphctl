import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createCreateSprintFlow } from '@src/application/flows/create-sprint/flow.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchCreateSprint = (ctx: LaunchContext): LaunchResult => {
  const { deps, snapshot, bridge, sessionId } = ctx;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  const element: Element<CreateSprintCtx> = createCreateSprintFlow({
    projectRepo: deps.app.projectRepo,
    sprintRepo: deps.app.sprintRepo,
    sprintExecutionRepo: deps.app.sprintExecutionRepo,
    interactive: deps.interactive,
    clock: deps.app.clock,
    eventBus: deps.app.eventBus,
    logger: deps.app.logger,
    appendFile: deps.app.appendFile,
    dataRoot: deps.storage.dataRoot,
  });
  const runner = createRunner<CreateSprintCtx>({
    id: sessionId(),
    element,
    initialCtx: { projectId: snapshot.project.id },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Create sprint — ${snapshot.project.displayName}`,
  };
};
