import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { renderContractMd } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import { buildEvaluatePrompt } from '@src/integration/ai/prompts/evaluate/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { roundBodyPath } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import {
  resolveRoundPaths,
  selfContainedGrounding,
} from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import { FLOOR_DIMENSIONS } from '../fixture-schema.ts';
import { gradeEvaluation } from '../grade.ts';
import { type FlowAdapter, validateWith } from './adapter.ts';
import { absPath, asFlow } from './narrow.ts';
import { buildInProgressTask } from './task.ts';

/**
 * Mirrors `EVALUATOR_GROUNDING` in `implement/leaves/evaluator.ts` (module-private there): the
 * reviewer's own grounding lines for a COLD corrective spawn. Only the corrective-nudge text uses it.
 */
const EVALUATOR_GROUNDING = [
  'Your PRIMARY INPUT is the uncommitted working-tree diff — inspect it via shell',
  '(`git status` / `git diff HEAD`) before grading. A verdict must reflect the actual',
  'work, never this message.',
] as const;

const ROLE = 'evaluator' as const;

/**
 * evaluate — one cold evaluator turn over `<base commit> + <uncommitted variant patch>`. Prompt,
 * contract section, session profile (FULL_AUTO, cwd = repo, additionalRoots = [sandbox, sprintDir])
 * and corrective validation all come from the production builders, so a trial measures what ships.
 */
export const evaluateAdapter: FlowAdapter = {
  flow: 'evaluate',

  plans: (fixture) =>
    fixture.flow === 'evaluate'
      ? fixture.variants.map((v) => ({
          variant: v.name,
          patchRel: v.patch,
          ...(v.defectClass !== undefined ? { defectClass: v.defectClass } : {}),
        }))
      : [],

  async prepare(ctx) {
    const fixture = asFlow(ctx.fixture, 'evaluate');
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

    const outputContractSection = renderContractSectionFor(evaluatorOutputContract, paths.value.outputDir);
    const prompt = await buildEvaluatePrompt(ctx.loader, {
      task: task.value,
      projectPath: String(ctx.workspace.repo),
      contractPath,
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
      selfContainedContext: selfContainedGrounding(ctx.workspace.sandbox, outputContractSection, EVALUATOR_GROUNDING),
      nudges: true,
      validate: validateWith(evaluatorOutputContract),
    });
  },

  async grade(ctx, outcome) {
    const fixture = asFlow(ctx.fixture, 'evaluate');
    if (!fixture.ok) return Result.error(fixture.error);
    const variant = fixture.value.variants.find((v) => v.name === ctx.plan.variant);
    if (variant === undefined) {
      return Result.error(
        new InvalidStateError({
          entity: 'eval-fixture',
          currentState: ctx.plan.variant,
          attemptedAction: 'grade',
          message: `fixture '${ctx.fixture.id}' has no variant '${ctx.plan.variant}'`,
        })
      );
    }
    const signal = outcome.signals.find((s): s is EvaluationSignal => s.type === 'evaluation');
    return Result.ok(
      gradeEvaluation(
        variant.expect,
        { valid: outcome.valid, ...(signal !== undefined ? { signal } : {}) },
        fixture.value.task.verificationCriteria.map((c) => c.id)
      )
    );
  },

  async dryRun(ctx) {
    const fixture = asFlow(ctx.fixture, 'evaluate');
    const variant = fixture.ok ? fixture.value.variants.find((v) => v.name === ctx.plan.variant) : undefined;
    if (!fixture.ok || variant === undefined) return { signals: [] };
    const { expect } = variant;
    const failing = new Set<string>(expect.failedDimensions ?? []);
    if (expect.status === 'failed' && failing.size === 0) failing.add('correctness');
    return {
      signals: [
        {
          type: 'evaluation',
          status: expect.status,
          dimensions: FLOOR_DIMENSIONS.map((d) =>
            failing.has(d)
              ? { dimension: d, passed: false, finding: `dry-run: seeded ${d} defect` }
              : { dimension: d, passed: true, finding: 'dry-run: no issue found' }
          ),
          criteria: fixture.value.task.verificationCriteria.map((c) => {
            const want = expect.criteria?.[c.id];
            return {
              id: c.id,
              passed: want?.passed ?? expect.status === 'passed',
              evidence: `${want?.evidencePrefix ?? 'dry-run'} evidence`,
            };
          }),
          critique: (expect.critiqueMarkers ?? []).join(' '),
        },
      ],
    };
  },
};
