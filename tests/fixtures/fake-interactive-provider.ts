/**
 * Minimal fake for {@link InteractiveAiProvider}. Used by full-stack tests that exercise
 * chains calling `interactiveAi.run()` (refine, plan-interactive) without actually spawning a
 * real AI CLI.
 *
 * The fake writes a scripted payload to the session's `outputFile` then returns `Result.ok({})`.
 * Tests that don't touch the interactive path at all can pass `unusedInteractiveAiProvider`
 * which throws immediately on any call.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
  InteractiveAiProviderOutput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';

/**
 * Scripted interactive AI provider. For each `run()` call:
 *  1. Ensures the output directory exists.
 *  2. Writes `output` (or an empty string when absent) to `input.outputFile`.
 *  3. Returns `Result.ok({ sessionId? })`.
 */
export const createFakeInteractiveProvider = (
  opts: {
    /** Content written to `outputFile` on each call. Defaults to an empty string. */
    readonly output?: string;
    /** Optional session id threaded into the output. */
    readonly sessionId?: string;
  } = {}
): InteractiveAiProvider => ({
  async run(input: InteractiveAiProviderInput): Promise<Result<InteractiveAiProviderOutput, DomainError>> {
    await fs.mkdir(dirname(String(input.outputFile)), { recursive: true });
    await fs.writeFile(String(input.outputFile), opts.output ?? '', 'utf8');
    return Result.ok(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {});
  },
});

/**
 * Interactive AI provider stub that throws on any call. Pass this when the test path is
 * guaranteed never to reach `interactiveAi.run()` — the throw makes accidental invocations
 * visible immediately instead of silently producing an empty output file.
 */
export const unusedInteractiveAiProvider: InteractiveAiProvider = {
  async run(input: InteractiveAiProviderInput): Promise<Result<InteractiveAiProviderOutput, DomainError>> {
    void input;
    return Result.error(
      new InvalidStateError({
        entity: 'fake-interactive-provider',
        currentState: 'unused',
        attemptedAction: 'run',
        message: 'unusedInteractiveAiProvider: interactiveAi.run() was called but this test does not expect it',
      })
    );
  },
};
