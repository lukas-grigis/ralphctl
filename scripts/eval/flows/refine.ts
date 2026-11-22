import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { createTicket } from '@src/domain/entity/ticket.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { RefinedTicketSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { buildRefinePrompt } from '@src/integration/ai/prompts/refine/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';
import { signalsSession } from '@src/application/flows/_shared/signals-session.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { gradeRefine } from '../grade.ts';
import type { FlowAdapter, PreparedTrial } from './adapter.ts';
import { absPath, asFlow } from './narrow.ts';

/**
 * refine — production's interactive interview, run headless. Each turn that ends without
 * `signals.json` gets the fixture's one standing `operatorReply` on the resumed session; question
 * order and count are the model's, so the reply never answers a specific question.
 */

/** Operator replies one trial may receive before it counts as unfinished (engineering judgment). */
const OPERATOR_TURN_CAP = 8;

const RUN_DIR = 'run';

// `claude -p` still lists a structured question tool nobody can answer, so pick the shipped format's no-tool branch.
const NO_QUESTION_TOOL =
  'This session has no structured question tool: ask in plain text as described above, then end your turn — the operator answers in the next message.';

const withNoQuestionTool = (loader: TemplateLoader): TemplateLoader => ({
  async load(name) {
    const loaded = await loader.load(name);
    return name === 'question-format' && loaded.ok
      ? Result.ok(`${loaded.value.trim()}\n\n${NO_QUESTION_TOOL}`)
      : loaded;
  },
});

// Production validates refine once, so only a missing file (a turn waiting on the operator) earns a reply.
const answerUntilWritten =
  (operatorReply: string): PreparedTrial['validate'] =>
  async (deps) => {
    let validated = await validateSignalsFile(deps.outputDir, refineOutputContract);
    for (
      let turn = 1;
      turn <= OPERATOR_TURN_CAP && !validated.ok && validated.error instanceof InvalidStateError;
      turn++
    ) {
      const replied = await deps.reinvoke(operatorReply as Prompt, turn);
      if (!replied.ok) return Result.error(replied.error);
      validated = await validateSignalsFile(deps.outputDir, refineOutputContract);
    }
    return validated.ok ? Result.ok({ signals: validated.value, nudgeCount: 0 }) : Result.error(validated.error);
  };

export const refineAdapter: FlowAdapter = {
  flow: 'refine',

  plans: () => [{ variant: 'default' }],

  async prepare(ctx) {
    const fixture = asFlow(ctx.fixture, 'refine');
    if (!fixture.ok) return Result.error(fixture.error);
    const { title, description } = fixture.value.ticket;
    const ticket = createTicket({ title, ...(description !== undefined ? { description } : {}) });
    if (!ticket.ok) return Result.error(ticket.error);

    const runDir = absPath(join(String(ctx.workspace.root), RUN_DIR));
    if (!runDir.ok) return Result.error(runDir.error);
    const paths = runPathsFor(runDir.value);
    if (!paths.ok) return Result.error(paths.error);
    const outputContractSection = renderContractSectionFor(refineOutputContract, runDir.value);
    const prompt = await buildRefinePrompt(withNoQuestionTool(ctx.loader), {
      ticket: ticket.value,
      outputContractSection,
      priorProgress: '',
    });
    if (!prompt.ok) return Result.error(prompt.error);

    return Result.ok({
      session: signalsSession({
        cwd: runDir.value,
        prompt: prompt.value,
        model: ctx.row.model,
        permissions: READ_ONLY,
        signalsFile: paths.value.signalsFile,
        outputDir: runDir.value,
        bodyFile: paths.value.bodyFile,
        effort: ctx.row.effort,
        abortSignal: ctx.abortSignal,
      }),
      outputDir: runDir.value,
      selfContainedContext: outputContractSection,
      nudges: false,
      validate: answerUntilWritten(fixture.value.operatorReply),
    });
  },

  async grade(ctx, outcome) {
    const fixture = asFlow(ctx.fixture, 'refine');
    if (!fixture.ok) return Result.error(fixture.error);
    const refined = outcome.signals.find((s): s is RefinedTicketSignal => s.type === 'refined-ticket');
    // body.txt holds the first turn only; later turns land in per-reply body files.
    const firstTurn = await fs
      .readFile(join(String(ctx.workspace.root), RUN_DIR, 'body.txt'), 'utf8')
      .catch(() => undefined);
    return Result.ok(gradeRefine(fixture.value, { valid: outcome.valid, body: refined?.body, firstTurn }));
  },

  async dryRun(ctx) {
    const fixture = asFlow(ctx.fixture, 'refine');
    if (!fixture.ok) return { signals: [] };
    const body = await fs.readFile(join(fixture.value.dir, fixture.value.referenceBody), 'utf8');
    return { signals: [{ type: 'refined-ticket', body }] };
  },
};
