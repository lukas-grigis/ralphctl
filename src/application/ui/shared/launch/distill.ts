import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DistillLearningsDeps } from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillStepOpts } from '@src/application/flows/_shared/memory/distill-step.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';

/** Resolve the pre-transition distill composition for the close-sprint / review launchers. */
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
    projectSlug: project.slug,
    memoryRoot: deps.storage.memoryRoot,
    distillRoot: distillRoot.value,
    repository,
    ai: settings.ai,
  };
  return { deps: distillDeps, opts };
};
