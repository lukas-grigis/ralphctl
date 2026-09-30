import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { renderContractMd } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { roundBodyPath } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import {
  resolveRoundPaths,
  selfContainedGrounding,
} from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import { gradeImplement } from '../grade.ts';
import { runOracle } from '../oracle.ts';
import { applyPatchFile, changedPaths } from '../workspace.ts';
import { type FlowAdapter, validateWith } from './adapter.ts';
import { absPath, asFlow } from './narrow.ts';
import { buildInProgressTask } from './task.ts';

const ROLE = 'generator' as const;

const GENERATOR_GROUNDING = [
  'Implement the task in the repository working tree, then emit the signals the output contract',
  'lists. A signal must reflect the actual work, never this message.',
] as const;

/**
 * implement — one cold generator turn on the buggy base repo. Grading is OUTCOME-based and runs in
 * the runner, never by the model: the hidden oracle must exit 0 AND no protected path may have
 * changed (a weakened visible test is a bypass, not a fix).
 */
export const implementAdapter: FlowAdapter = {
  flow: 'implement',

  plans: () => [{ variant: 'default' }],

  async prepare(ctx) {
    const fixture = asFlow(ctx.fixture, 'implement');
    if (!fixture.ok) return Result.error(fixture.error);
    const task = buildInProgressTask(fixture.value.task);
    if (!task.ok) return Result.error(task.error);
    const paths = resolveRoundPaths(ctx.workspace.sandbox, 1, ROLE);
    if (!paths.ok) return Result.error(paths.error);
    const bodyFile = absPath(roundBodyPath(ctx.workspace.sandbox, 1, ROLE));
    if (!bodyFile.ok) return Result.error(bodyFile.error);

    const contractPath = join(String(ctx.workspace.sandbox), 'contract.md');
    const wroteContract = await writeTextAtomic(contractPath, renderContractMd(task.value));
    if (!wroteContract.ok) return Result.error(wroteContract.error);

    const outputContractSection = renderContractSectionFor(generatorOutputContract, paths.value.outputDir);
    const prompt = await buildImplementPrompt(ctx.loader, {
      task: task.value,
      projectPath: String(ctx.workspace.repo),
      contractPath,
      progressFile: join(String(ctx.workspace.root), 'progress.md'),
      priorProgress: '',
      outputContractSection,
      ...(fixture.value.verifyScript !== undefined ? { verifyScript: fixture.value.verifyScript } : {}),
      ...(fixture.value.projectTooling !== undefined ? { projectTooling: fixture.value.projectTooling } : {}),
    });
    if (!prompt.ok) return Result.error(prompt.error);

    return Result.ok({
      session: implementSession(
        ctx.workspace.sandbox,
        ctx.workspace.repo,
        ctx.workspace.root,
        prompt.value,
        ctx.row.model,
        paths.value.signalsFile,
        ROLE,
        undefined,
        ctx.row.effort,
        ctx.abortSignal,
        bodyFile.value
      ),
      outputDir: paths.value.outputDir,
      selfContainedContext: selfContainedGrounding(ctx.workspace.sandbox, outputContractSection, GENERATOR_GROUNDING),
      nudges: true,
      validate: validateWith(generatorOutputContract),
    });
  },

  async grade(ctx, outcome) {
    const fixture = asFlow(ctx.fixture, 'implement');
    if (!fixture.ok) return Result.error(fixture.error);
    // Snapshot what the model changed BEFORE the oracle (and its restore of protected paths) touches the tree.
    const changed = await changedPaths(ctx.toolbox.git, ctx.workspace.repo);
    if (!changed.ok) return Result.error(changed.error);
    const oracle = await runOracle(
      { shell: ctx.toolbox.shell },
      ctx.workspace,
      fixture.value.dir,
      fixture.value.oracle,
      ctx.abortSignal
    );
    if (!oracle.ok) return Result.error(oracle.error);
    const wroteOracle = await writeTextAtomic(join(String(ctx.artifactDir), 'oracle.txt'), oracle.value.output);
    if (!wroteOracle.ok) return Result.error(wroteOracle.error);
    return Result.ok(
      gradeImplement({
        valid: outcome.valid,
        oraclePassed: oracle.value.passed,
        changedPaths: changed.value,
        protectedPaths: fixture.value.oracle.protectedPaths,
        claimedComplete: outcome.signals.some((s) => s.type === 'task-complete' || s.type === 'task-verified'),
      })
    );
  },

  async dryRun(ctx) {
    const fixture = asFlow(ctx.fixture, 'implement');
    return {
      signals: [{ type: 'task-verified', output: 'dry-run: reference patch applied' }, { type: 'task-complete' }],
      ...(fixture.ok
        ? {
            sideEffect: async (): Promise<void> => {
              await applyPatchFile(
                ctx.toolbox.git,
                ctx.workspace.repo,
                join(fixture.value.dir, fixture.value.referencePatch)
              );
            },
          }
        : {}),
    };
  },
};
