import { ZodError } from 'zod';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';

/**
 * One corrective retry on a *recoverable* `signals.json` contract failure.
 *
 * The first whole-array Zod parse is all-or-nothing: a single malformed element (wrong shape,
 * truncated JSON, a vacuous evaluation that now fails the floor-dimension refinement) fails the
 * entire validation and — before this helper — the generator / evaluator turn self-blocked the
 * task with **zero** retries. That converts a near-miss (the AI almost wrote the right shape)
 * into a terminal block, and the floor-dimension refinement landed alongside this helper for
 * exactly that reason: without it, today's vacuous passes would become terminal blocks instead
 * of one extra corrective round.
 *
 * Flow (one retry, no loop — chain-level retry primitives are banned; in-leaf branching is fine):
 *
 *   1. {@link validateSignalsFile} the spawn's output dir. On success, return immediately.
 *   2. On a NON-correctable failure (user abort, rate-limit, or a `MigrationGapError` the AI
 *      cannot fix by re-emitting), return the error verbatim — the caller self-blocks.
 *   3. On a CORRECTABLE failure (signals-missing / invalid-json / schema-mismatch), build a
 *      short corrective prompt gated by the error class, re-invoke the provider ONCE via the
 *      caller-supplied {@link reinvoke} callback (the leaf owns the resumed spawn so session /
 *      resume / abort threading stays there), then re-validate. Return whichever Result the
 *      second validation produced — success on a fixed file, the second error on a repeat miss.
 *
 * `reinvoke(corrective)` MUST spawn the provider on the SAME resumed session (so the model sees
 * the corrective message as a follow-up turn) targeting the SAME `signals.json` path, then
 * resolve once the spawn has returned. A spawn-level error (`Result.error`) short-circuits — the
 * caller self-blocks with that error. `AbortError` from the re-invoke propagates transparently.
 */
export interface CorrectiveRetryDeps {
  readonly outputDir: AbsolutePath;
  readonly logger: Logger;
  /**
   * Re-run the provider on the resumed session with the corrective `Prompt` and re-target the
   * same `signals.json`. Resolves with the spawn-level Result (the leaf maps a clean spawn to
   * `Result.ok(undefined)`; a non-zero / errored spawn to `Result.error`).
   */
  readonly reinvoke: (corrective: Prompt) => Promise<Result<void, DomainError>>;
}

/**
 * A contract failure is *correctable by re-prompting* when the AI could plausibly fix it on a
 * follow-up turn: it forgot to write the file, wrote invalid JSON, or wrote the wrong shape.
 *
 * NOT correctable, so we skip the retry and let the caller self-block immediately:
 *   - `Aborted` — user cancel; the retry would race the teardown and the corrective spawn would
 *     just re-abort. AbortError must propagate transparently (CLAUDE.md §AbortError).
 *   - `RateLimit` — the adapter already exhausted its 429 retries; re-spawning re-hits the wall.
 *   - `MigrationGap` — an on-disk version older than the contract with a missing migration step;
 *     the AI cannot fix a harness-side migration gap by re-emitting signals.
 */
const isCorrectableContractError = (err: DomainError): boolean =>
  err.code !== ErrorCode.Aborted && err.code !== ErrorCode.RateLimit && err.code !== ErrorCode.MigrationGap;

/**
 * Build the corrective message body, gated by error class. Zod issue lists exist ONLY for
 * `schema-mismatch` (the parse error carries the `ZodError` in `cause`); `invalid-json` and
 * `signals-missing` need their own short text since there is nothing to enumerate.
 */
const correctiveBody = (err: DomainError, signalsPath: string): string => {
  const lines: string[] = [];
  lines.push('Your previous `signals.json` did not satisfy the output contract, so the harness could');
  lines.push('not read a verdict. Fix it now in ONE follow-up — re-read the output-contract section');
  lines.push('above and re-write the file. Do not change anything else.');
  lines.push('');

  if (err instanceof ParseError && err.subCode === 'schema-mismatch' && err.cause instanceof ZodError) {
    lines.push('The shape failed schema validation. Each line below is one problem — fix every one:');
    lines.push('');
    for (const issue of err.cause.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`- at \`${path}\`: ${issue.message}`);
    }
    lines.push('');
    lines.push('Common cause: a terminal `evaluation` verdict (`passed` / `failed`) MUST grade all four');
    lines.push('floor dimensions — correctness, completeness, safety, consistency — each with a finding.');
  } else if (err instanceof ParseError && err.subCode === 'invalid-json') {
    lines.push(`The file at \`${signalsPath}\` existed but was not valid JSON. Re-write it as a single`);
    lines.push('valid JSON object matching the `{ schemaVersion, signals }` shape. Check for trailing');
    lines.push('commas, unescaped quotes inside string fields, and truncated output.');
  } else {
    // signals-missing (InvalidStateError) or any other correctable shape.
    lines.push(`You did not write \`${signalsPath}\`. Write that exact absolute path now with your`);
    lines.push('`Write` tool, matching the `{ schemaVersion, signals }` shape from the contract above.');
  }

  lines.push('');
  lines.push(`Write the corrected file to the exact absolute path \`${signalsPath}\` and stop.`);
  return lines.join('\n');
};

/**
 * Validate the spawn's `signals.json`; on a correctable contract failure, re-prompt once on the
 * resumed session and re-validate. See the module docstring for the full flow + rationale.
 */
export const validateSignalsFileWithCorrectiveRetry = async <TSig extends AiSignal>(
  deps: CorrectiveRetryDeps,
  contract: AiOutputContract<TSig>
): Promise<Result<readonly TSig[], DomainError>> => {
  const first = await validateSignalsFile(deps.outputDir, contract);
  if (first.ok) return first;

  const err: DomainError = first.error;
  if (!isCorrectableContractError(err)) return Result.error(err);

  const log = deps.logger.named('ai.contract.corrective-retry');
  const signalsPath = `${String(deps.outputDir)}/signals.json`;
  log.warn('signals.json failed the contract — issuing one corrective retry', {
    outputDir: String(deps.outputDir),
    error: err.message,
  });

  const corrective = correctiveBody(err, signalsPath) as Prompt;
  const respawn = await deps.reinvoke(corrective);
  if (!respawn.ok) {
    log.warn('corrective retry spawn failed — self-blocking on the spawn error', {
      outputDir: String(deps.outputDir),
      error: respawn.error.message,
    });
    return Result.error(respawn.error);
  }

  const second = await validateSignalsFile(deps.outputDir, contract);
  if (second.ok) {
    log.info('corrective retry produced a valid signals.json', { outputDir: String(deps.outputDir) });
    return second;
  }
  log.warn('corrective retry still failed the contract — self-blocking', {
    outputDir: String(deps.outputDir),
    error: second.error.message,
  });
  return Result.error(second.error);
};
