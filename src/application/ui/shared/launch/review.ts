import { join } from 'node:path';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { resolveDistillComposition } from '@src/application/ui/shared/launch/distill.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

/**
 * Derive the set of repositories the sprint actually touches — `Project.repositories` filtered down to the ones
 * referenced by `Task.repositoryId`.
 */
const sprintAffectedRepositories = (
  repositories: readonly Repository[],
  taskRepositoryIds: ReadonlySet<string>
): readonly Repository[] => {
  if (taskRepositoryIds.size === 0) return repositories;
  return repositories.filter((r) => taskRepositoryIds.has(String(r.id)));
};

/**
 * Render the `{{REPOSITORIES}}` block fed to apply-feedback. Mirrors plan / ideate format: `` - `<absolute-path>`
 * (<name>) ``.
 */
const renderRepositoriesBlock = (affected: readonly Repository[]): string =>
  affected.map((r) => `- \`${String(r.path)}\` (${r.name})`).join('\n');

export const launchReview = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, provider, bridge, sessionId, effort } = ctx;
  const missing = await checkCli('review', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!snapshot.project) return { ok: false, reason: 'No project loaded for the selected sprint.' };
  if (snapshot.project.repositories.length === 0) {
    return { ok: false, reason: 'Project has no repositories — add one first.' };
  }
  // Opt-in, default-NO HITL — symmetric with close-sprint.
  const distillConfirm = await deps.interactive.askConfirm({
    message: "Distill this sprint's learnings into project context files when review finishes? [y/N]",
    defaultValue: false,
  });
  if (!distillConfirm.ok) return { ok: false, reason: 'Cancelled.' };
  const distillRequested = distillConfirm.value === true;
  // Direct-build the canonical `<id>--<slug>/` sprint dir from the loaded sprint entity.
  const sprintDir = AbsolutePath.parse(buildSprintDir(deps.storage.dataRoot, snapshot.sprint.id, snapshot.sprint.slug));
  if (!sprintDir.ok) return { ok: false, reason: sprintDir.error.message };
  const feedbackPath = AbsolutePath.parse(join(String(sprintDir.value), 'feedback.md'));
  if (!feedbackPath.ok) return { ok: false, reason: feedbackPath.error.message };
  const progressPath = AbsolutePath.parse(join(String(sprintDir.value), 'progress.md'));
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };
  // `<sprintDir>/review/` — parent of per-round AI session dirs (`round-1/`, `round-2/`, …).
  const reviewRoot = AbsolutePath.parse(join(String(sprintDir.value), 'review'));
  if (!reviewRoot.ok) return { ok: false, reason: reviewRoot.error.message };

  // Sprint-affected repos: intersect `task.repositoryId` with `project.repositories`.
  const taskRepoIds = new Set<string>(snapshot.tasks.map((t) => String(t.repositoryId)));
  const affected = sprintAffectedRepositories(snapshot.project.repositories, taskRepoIds);
  if (affected.length === 0) {
    return {
      ok: false,
      reason: 'No sprint-affected repositories — sprint has tasks but none of them match a project repo.',
    };
  }
  // Commit / verify still target a single repo (review operates against one branch); pick
  // the first sprint-affected repo. Multi-repo commit / verify is out of scope for this fix.
  const commitRepo = affected[0]!;
  // Reuse the verify-script wired on the picked commit repo so review verifies the same way
  // implement did — keeps the "done means green" invariant intact across the two phases.
  const verifyScript = commitRepo.verifyScript;

  const distill = resolveDistillComposition(ctx, String(sprintDir.value));
  const element: Element<ReviewCtx> = createReviewFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      taskRepo: deps.app.taskRepo,
      provider,
      templateLoader: deps.app.templateLoader,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      interactive: deps.interactive,
      gitRunner: deps.app.gitRunner,
      shellScriptRunner: deps.app.shellScriptRunner,
      fileLocker: deps.app.fileLocker,
      locksRoot: deps.storage.locksRoot,
      appendFile: deps.app.appendFile,
      writeFile: deps.app.writeFile,
      // Review uses the implement generator model + effort — same code-mutation profile, same accuracy expectations.
      // No per-flow `review` row in settings today.
      model: settings.ai.implement.generator.model,
      ...(effort !== undefined ? { effort } : {}),
      ...(distill !== undefined ? { distill } : {}),
    },
    {
      sprintId: snapshot.sprint.id,
      sprintDir: sprintDir.value,
      reviewRoot: reviewRoot.value,
      commitCwd: commitRepo.path,
      additionalRoots: affected.map((r) => r.path),
      repositoriesBlock: renderRepositoriesBlock(affected),
      feedbackFile: feedbackPath.value,
      progressFile: progressPath.value,
      ...(verifyScript !== undefined ? { verifyScript } : {}),
    }
  );
  const runner = createRunner<ReviewCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id, distillRequested },
  });
  return { ok: true, runner: bridge(runner) as Runner<unknown>, title: `Review — ${snapshot.sprint.name}` };
};
