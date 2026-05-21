import { join } from 'node:path';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchReview = (ctx: LaunchContext): LaunchResult => {
  const { deps, snapshot, extras, settings, provider, cwd, bridge, sessionId } = ctx;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };
  const feedbackPath = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'feedback.md')
  );
  if (!feedbackPath.ok) return { ok: false, reason: feedbackPath.error.message };
  const progressPath = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'progress.md')
  );
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };
  // Reuse the verify-script wired on the project so review verifies the same way implement did —
  // keeps the "done means green" invariant intact across the two phases.
  const verifyScript = snapshot.project?.repositories.find((r) => r.verifyScript !== undefined)?.verifyScript;

  const element: Element<ReviewCtx> = createReviewFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      taskRepo: deps.app.taskRepo,
      provider,
      templateLoader: deps.app.templateLoader,
      signals: deps.app.signals,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      interactive: deps.interactive,
      gitRunner: deps.app.gitRunner,
      shellScriptRunner: deps.app.shellScriptRunner,
      fileLocker: deps.app.fileLocker,
      locksRoot: deps.storage.locksRoot,
      // Review uses the implement model tier — same code-mutation profile, same accuracy
      // expectations. No per-flow `review` model in settings today.
      model: extras.modelOverride ?? settings.ai.models.implement,
    },
    {
      sprintId: snapshot.sprint.id,
      cwd,
      feedbackFile: feedbackPath.value,
      progressFile: progressPath.value,
      ...(verifyScript !== undefined ? { verifyScript } : {}),
    }
  );
  const runner = createRunner<ReviewCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  return { ok: true, runner: bridge(runner) as Runner<unknown>, title: `Review — ${snapshot.sprint.name}` };
};
