import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createDetectScriptsFlow } from '@src/application/flows/detect-scripts/flow.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchDetectScripts = (ctx: LaunchContext): LaunchResult => {
  const { deps, snapshot, extras, settings, provider, bridge, sessionId, effort } = ctx;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  const element: Element<DetectScriptsCtx> = createDetectScriptsFlow(
    {
      projectRepo: deps.app.projectRepo,
      provider,
      templateLoader: deps.app.templateLoader,
      signals: deps.app.signals,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      interactive: deps.interactive,
      runsRoot: deps.storage.runsRoot,
    },
    {
      projectId: snapshot.project.id,
      // Reuse the readiness row — both flows are read-only inventory round-trips.
      // Override flows in through ctx.settings (launcher applied it to ai.readiness when the
      // picker emitted a non-empty override), so per-field fallback is automatic.
      model: settings.ai.readiness.model,
      ...(effort !== undefined ? { effort } : {}),
      ...(extras.repositoryId !== undefined ? { repositoryId: extras.repositoryId } : {}),
    }
  );
  const runner = createRunner<DetectScriptsCtx>({
    id: sessionId(),
    element,
    initialCtx: {
      projectId: snapshot.project.id,
      ...(extras.repositoryId !== undefined ? { repositoryId: extras.repositoryId } : {}),
    },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Detect scripts — ${snapshot.project.displayName}`,
  };
};
