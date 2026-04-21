import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { createOnboardPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import type { OnboardContext, OnboardOptions } from '@src/business/pipelines/onboard.ts';
import { EXIT_ERROR, exitWithCode } from '@src/domain/exit-codes.ts';
import { showError, showSuccess } from '@src/integration/ui/theme/ui.ts';

export interface ProjectOnboardCommandOptions extends OnboardOptions {
  project: string;
}

export async function projectOnboardCommand(options: ProjectOnboardCommandOptions): Promise<void> {
  const shared = getSharedDeps();
  const pipeline = createOnboardPipeline(shared, options);

  const initialContext: OnboardContext = {
    sprintId: '',
    projectName: options.project,
  };

  const result = await executePipeline(pipeline, initialContext);

  if (!result.ok) {
    showError(`Onboarding failed: ${result.error.message}`);
    exitWithCode(EXIT_ERROR);
  }

  const ctx = result.value.context;
  if (options.dryRun) {
    shared.logger.info('Dry run — no files written.');
    if (ctx.agentsMdDraft) {
      shared.logger.info(
        `Project context file draft (${String(ctx.agentsMdDraft.split('\n').length)} lines) ready for review.`
      );
    }
    return;
  }

  if (ctx.alreadyCurrent) {
    shared.logger.info('Already up to date — no changes needed.');
    return;
  }

  const fields: [string, string][] = [];
  if (ctx.writtenPath) fields.push(['Project context file', ctx.writtenPath]);
  if (ctx.checkScriptFinal) fields.push(['Check script', ctx.checkScriptFinal]);
  if (ctx.driftWarnings && ctx.driftWarnings.length > 0) {
    fields.push(['Warnings', ctx.driftWarnings.join('; ')]);
  }
  showSuccess('Repository onboarded', fields);
}
