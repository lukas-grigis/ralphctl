import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

export const launchReadiness = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, extras, settings, provider, skillsAdapter, skillSource, cwd, bridge, sessionId, effort } =
    ctx;
  const missing = await checkCli('readiness', settings);
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };
  const element: Element<ReadinessCtx> = createReadinessFlow(
    {
      projectRepo: deps.app.projectRepo,
      probes: deps.app.probes,
      provider,
      templateLoader: deps.app.templateLoader,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      interactive: deps.interactive,
      writeFile: deps.app.writeFile,
      clock: deps.app.clock,
      skillsAdapter,
      skillSource,
      runsRoot: deps.storage.runsRoot,
    },
    {
      projectId: snapshot.project.id,
      cwd,
      model: extras.modelOverride ?? settings.ai.readiness.model,
      ...(effort !== undefined ? { effort } : {}),
    }
  );
  const runner = createRunner<ReadinessCtx>({
    id: sessionId(),
    element,
    initialCtx: { projectId: snapshot.project.id },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Readiness — ${snapshot.project.displayName}`,
  };
};
