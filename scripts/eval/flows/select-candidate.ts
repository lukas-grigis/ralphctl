import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { CandidateSelectionSignal } from '@src/domain/signal.ts';
import { buildSelectCandidatePrompt } from '@src/integration/ai/prompts/select-candidate/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { selectCandidateOutputContract } from '@src/application/flows/implement/leaves/select-candidate.contract.ts';
import { composeCandidateSummary } from '@src/application/flows/implement/leaves/best-of-n-record.ts';
import { readOnlySignalsSession } from '@src/application/flows/_shared/signals-session.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { gradeSelectCandidate } from '../grade.ts';
import { type FlowAdapter, validateWith } from './adapter.ts';
import { absPath, asFlow } from './narrow.ts';
import { buildInProgressTask } from './task.ts';

/**
 * select-candidate — the pairwise judge over two compact candidate summaries. Every item runs in
 * BOTH candidate orders (`ab` and `ba`): production's swap-and-agree (`best-of-n-selection.ts`,
 * arXiv 2306.05685) exists because a judge can favour a slot, so a single order would measure
 * position bias as much as judgment.
 *
 * The session is `readOnlySignalsSession` — field-for-field what `best-of-n-judge.ts`'s private
 * `buildJudgeSession` returns (READ_ONLY, cwd, outputDir, bodyFile, effort, abortSignal), so the
 * judge builder is reused through its public twin rather than copied or exported.
 */

/** The `composeCandidateSummary` input a fixture's `candidates/<x>.json` holds. */
const SummaryInputSchema = z
  .object({
    hadDiff: z.boolean(),
    changedFiles: z.array(z.string()),
    verifyOutcome: z.enum(['success', 'failed', 'spawn-error', 'skipped']),
    attribution: z.enum(['clean', 'regressed', 'baseline-broken', 'fixed-baseline']).optional(),
    proposedCommitMessage: z.object({ subject: z.string(), body: z.string().optional() }).strict().optional(),
    changesEmitted: z.array(z.string()),
    notesEmitted: z.array(z.string()),
  })
  .strict();

const readSummary = async (path: string): Promise<Result<string, ParseError>> => {
  try {
    const parsed = SummaryInputSchema.safeParse(JSON.parse(await fs.readFile(path, 'utf8')));
    if (!parsed.success) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        })
      );
    }
    const { attribution, proposedCommitMessage, ...rest } = parsed.data;
    return Result.ok(
      composeCandidateSummary({
        ...rest,
        ...(attribution !== undefined ? { attribution } : {}),
        ...(proposedCommitMessage !== undefined
          ? {
              proposedCommitMessage: {
                subject: proposedCommitMessage.subject,
                ...(proposedCommitMessage.body !== undefined ? { body: proposedCommitMessage.body } : {}),
              },
            }
          : {}),
      })
    );
  } catch (cause) {
    return Result.error(new ParseError({ subCode: 'invalid-json', message: `${path}: ${messageOf(cause)}`, cause }));
  }
};

export const selectCandidateAdapter: FlowAdapter = {
  flow: 'select-candidate',

  plans: () => [
    { variant: 'ab', order: 'ab' },
    { variant: 'ba', order: 'ba' },
  ],

  async prepare(ctx) {
    const fixture = asFlow(ctx.fixture, 'select-candidate');
    if (!fixture.ok) return Result.error(fixture.error);
    const task = buildInProgressTask(fixture.value.task);
    if (!task.ok) return Result.error(task.error);
    const a = await readSummary(join(fixture.value.dir, fixture.value.candidates.a.summary));
    if (!a.ok) return Result.error(a.error);
    const b = await readSummary(join(fixture.value.dir, fixture.value.candidates.b.summary));
    if (!b.ok) return Result.error(b.error);
    const [first, second] = ctx.plan.order === 'ba' ? [b.value, a.value] : [a.value, b.value];

    const runDir = absPath(join(String(ctx.workspace.root), 'run'));
    if (!runDir.ok) return Result.error(runDir.error);
    const paths = runPathsFor(runDir.value);
    if (!paths.ok) return Result.error(paths.error);
    const outputContractSection = renderContractSectionFor(selectCandidateOutputContract, runDir.value);
    const prompt = await buildSelectCandidatePrompt(ctx.loader, {
      task: task.value,
      candidate1Summary: first,
      candidate2Summary: second,
      outputContractSection,
    });
    if (!prompt.ok) return Result.error(prompt.error);

    return Result.ok({
      session: readOnlySignalsSession({
        cwd: ctx.workspace.repo,
        prompt: prompt.value,
        model: ctx.row.model,
        signalsFile: paths.value.signalsFile,
        outputDir: runDir.value,
        bodyFile: paths.value.bodyFile,
        ...(ctx.row.effort !== undefined ? { effort: ctx.row.effort } : {}),
        ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
      }),
      outputDir: runDir.value,
      selfContainedContext: outputContractSection,
      nudges: false,
      validate: validateWith(selectCandidateOutputContract),
    });
  },

  async grade(ctx, outcome) {
    const fixture = asFlow(ctx.fixture, 'select-candidate');
    if (!fixture.ok) return Result.error(fixture.error);
    const verdict = outcome.signals.find((s): s is CandidateSelectionSignal => s.type === 'candidate-selection');
    return Result.ok(
      gradeSelectCandidate({
        valid: outcome.valid,
        winnerSlot: verdict?.winner,
        order: ctx.plan.order ?? 'ab',
        winner: fixture.value.winner,
      })
    );
  },

  async dryRun(ctx) {
    const fixture = asFlow(ctx.fixture, 'select-candidate');
    const firstSlot = ctx.plan.order === 'ba' ? 'b' : 'a';
    const winner = fixture.ok && fixture.value.winner === firstSlot ? 1 : 2;
    return { signals: [{ type: 'candidate-selection', winner, rationale: 'dry-run: picked the known winner' }] };
  },
};
