import { ZodError } from 'zod';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';

/**
 * Bounded corrective retries on a *recoverable* `signals.json` contract failure. The whole-array
 * parse is all-or-nothing, so without this a near-miss (one malformed element, truncated JSON)
 * self-blocks the task on the spot.
 *
 * Validate; on a correctable failure, up to `correctiveRetries` times: build a corrective prompt
 * from the LATEST error, `reinvoke` the provider, re-validate. This is an in-leaf bounded loop like
 * `run-with-rate-limit-retry.ts`, not a chain-level retry primitive. A spawn error, or an error
 * that stopped being correctable, short-circuits; exhausting every nudge returns the last
 * contract error so the caller self-blocks.
 *
 * `reinvoke(corrective, attempt)` MUST spawn on the SAME resumed session, targeting the SAME
 * `signals.json`, and resolve once the spawn returns; `AbortError` from it propagates
 * transparently. `attempt` (1-based) names per-nudge forensic artifacts.
 */
export interface CorrectiveRetryDeps {
  readonly outputDir: AbsolutePath;
  readonly logger: Logger;
  /** `settings.harness.correctiveRetries`; each nudge is one full resumed spawn, `0` means none. */
  readonly correctiveRetries: number;
  readonly reinvoke: (corrective: Prompt, attempt: number) => Promise<Result<void, DomainError>>;
  /**
   * The output-contract section plus role context, appended to every corrective body. Load-bearing:
   * resume is best-effort (an adapter may respawn COLD), and a cold spawn whose whole prompt is the
   * error text gives an evaluator just enough to FABRICATE a `passed` verdict for work it never saw.
   */
  readonly selfContainedContext: string;
}

/**
 * ALLOW-list of what a follow-up turn can fix: signals-missing (`InvalidStateError`) and invalid
 * JSON / schema mismatch (`ParseError`). Fails closed — abort, rate-limit, migration gaps and
 * harness-side `StorageError`s (EACCES, EISDIR) self-block at once instead of burning nudges.
 */
const isCorrectableContractError = (err: DomainError): boolean =>
  err instanceof InvalidStateError || err instanceof ParseError;

/** Past the first few Zod issues the model gains nothing from more. */
const MAX_ENUMERATED_ISSUES = 10;

// Corrective body branches: missing file, invalid JSON, Zod issue list, other rejected content.
const correctiveBody = (err: DomainError, signalsPath: string, selfContainedContext: string): string => {
  const lines: string[] = [];
  lines.push('Your previous `signals.json` did not satisfy the output contract, so the harness could');
  lines.push('not read a verdict. Fix it now in ONE follow-up — re-read the output-contract section');
  lines.push('below and re-write the file. Do not change anything else.');
  lines.push('');

  if (err instanceof InvalidStateError) {
    lines.push(`You did not write \`${signalsPath}\`. Write that exact absolute path now with your`);
    lines.push('`Write` tool, matching the `{ schemaVersion, signals }` shape from the contract above.');
  } else if (err instanceof ParseError && err.subCode === 'invalid-json') {
    lines.push(`The file at \`${signalsPath}\` existed but was not valid JSON. Re-write it as a single`);
    lines.push('valid JSON object matching the `{ schemaVersion, signals }` shape. Check for trailing');
    lines.push('commas, unescaped quotes inside string fields, and truncated output.');
  } else if (err instanceof ParseError && err.cause instanceof ZodError) {
    lines.push('The shape failed schema validation. Each line below is one problem — fix every one:');
    lines.push('');
    const issues = err.cause.issues;
    for (const issue of issues.slice(0, MAX_ENUMERATED_ISSUES)) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`- at \`${path}\`: ${issue.message}`);
    }
    if (issues.length > MAX_ENUMERATED_ISSUES) {
      lines.push(
        `- …plus ${String(issues.length - MAX_ENUMERATED_ISSUES)} more of the same kinds — fix the pattern, not just the listed lines.`
      );
    }
  } else {
    lines.push(`The file at \`${signalsPath}\` was read but rejected: ${err.message}`);
    lines.push('Re-write it as a single JSON object matching the `{ schemaVersion, signals }` shape.');
  }

  lines.push('');
  lines.push(`Write the corrected file to the exact absolute path \`${signalsPath}\` and stop.`);
  lines.push('');
  lines.push('If this session does not already hold the task context (fresh session), re-read the');
  lines.push('referenced on-disk files before acting — do NOT invent a verdict or content from this');
  lines.push('message alone.');
  lines.push('');
  lines.push(selfContainedContext);
  return lines.join('\n');
};

export interface CorrectiveRetryOutcome<TSig extends AiSignal> {
  readonly signals: readonly TSig[];
  /**
   * Nudges consumed before a valid file landed (`0` = first parse). Nudges spend no turn/attempt
   * budget, so this is the only signal that a self-correcting AI is silently burning spawns.
   */
  readonly nudgeCount: number;
}

export const validateSignalsFileWithCorrectiveRetry = async <TSig extends AiSignal>(
  deps: CorrectiveRetryDeps,
  contract: AiOutputContract<TSig>
): Promise<Result<CorrectiveRetryOutcome<TSig>, DomainError>> => {
  const first = await validateSignalsFile(deps.outputDir, contract);
  if (first.ok) return Result.ok({ signals: first.value, nudgeCount: 0 });

  let lastErr: DomainError = first.error;
  if (!isCorrectableContractError(lastErr)) return Result.error(lastErr);

  const log = deps.logger.named('ai.contract.corrective-retry');
  const signalsPath = `${String(deps.outputDir)}/signals.json`;
  const maxRetries = Math.max(0, deps.correctiveRetries);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log.warn(`signals.json failed the contract — corrective retry ${String(attempt)}/${String(maxRetries)}`, {
      outputDir: String(deps.outputDir),
      error: lastErr.message,
    });

    const corrective = correctiveBody(lastErr, signalsPath, deps.selfContainedContext) as Prompt;
    const respawn = await deps.reinvoke(corrective, attempt);
    if (!respawn.ok) {
      log.warn('corrective retry spawn failed — self-blocking on the spawn error', {
        outputDir: String(deps.outputDir),
        attempt,
        error: respawn.error.message,
      });
      return Result.error(respawn.error);
    }

    const revalidated = await validateSignalsFile(deps.outputDir, contract);
    if (revalidated.ok) {
      log.info('corrective retry produced a valid signals.json', { outputDir: String(deps.outputDir), attempt });
      return Result.ok({ signals: revalidated.value, nudgeCount: attempt });
    }
    lastErr = revalidated.error;
    // A nudge can turn a correctable failure into a non-correctable one (signals.json became a directory).
    if (!isCorrectableContractError(lastErr)) {
      log.warn('corrective retry produced a non-correctable error — self-blocking without a further nudge', {
        outputDir: String(deps.outputDir),
        attempt,
        error: lastErr.message,
      });
      return Result.error(lastErr);
    }
  }

  log.warn('corrective retries exhausted — self-blocking', {
    outputDir: String(deps.outputDir),
    attempts: maxRetries,
    error: lastErr.message,
  });
  return Result.error(lastErr);
};
