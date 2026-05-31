import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DistillLearningsDeps } from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillStepOpts } from '@src/application/flows/_shared/memory/distill-step.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';

/**
 * Resolve the pre-transition distill composition for the close-sprint / review launchers —
 * the slim {@link DistillLearningsDeps} plus the static {@link DistillStepOpts} both flows hand to
 * their flow factory's optional `distill` field.
 *
 * Returns `undefined` (so the host flow omits the distill step) when the launch lacks the context
 * the sub-chain needs:
 *  - no project loaded → no learnings ledger to read;
 *  - the project has no repository → no native context file to fold learnings into;
 *  - the per-provider sandbox path under the sprint dir cannot be parsed.
 *
 * `repository` is the project's FIRST repository — the distill prompt folds the curated learnings
 * into one repo's native context files; multi-repo distill (one per affected repo) is deferred.
 *
 * Deps come from the wired `AppDeps` (the per-provider `interactiveAiFor`, `templateLoader`,
 * `writeFile`, `logger`, `clock`) plus the launcher-level `runInTerminal` (Ink-aware, can't live in
 * `wire()`) and `interactive` prompt port.
 */
export const resolveDistillComposition = (
  ctx: LaunchContext,
  sprintDir: string
): { readonly deps: DistillLearningsDeps; readonly opts: DistillStepOpts } | undefined => {
  const { deps, snapshot, settings } = ctx;
  const project = snapshot.project;
  if (project === undefined) return undefined;
  const repository = project.repositories[0];
  if (repository === undefined) return undefined;

  const distillRoot = AbsolutePath.parse(join(sprintDir, 'distill'));
  if (!distillRoot.ok) return undefined;

  const distillDeps: DistillLearningsDeps = {
    interactiveAiFor: deps.app.interactiveAiFor,
    runInTerminal: deps.runInTerminal,
    templateLoader: deps.app.templateLoader,
    interactive: deps.interactive,
    writeFile: deps.app.writeFile,
    logger: deps.app.logger,
    clock: deps.app.clock,
  };
  const opts: DistillStepOpts = {
    projectId: project.id,
    memoryRoot: deps.storage.memoryRoot,
    distillRoot: distillRoot.value,
    repository,
    ai: settings.ai,
  };
  return { deps: distillDeps, opts };
};
