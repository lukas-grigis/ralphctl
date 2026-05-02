/**
 * `FakeProcessRunner` — scripted fake of {@link ProcessRunner} used by
 * the session-runner / session-adapter tests so they don't have to spawn
 * real binaries. Captures every call's arguments for assertions and
 * returns the next scripted outcome.
 *
 * Lives under `integration/_test-fakes/` rather than
 * `business/_test-fakes/` because {@link ProcessRunner} is an
 * integration-internal seam — the business layer never sees it.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner } from '@src/integration/ai/session/process-runner.ts';

/** Scripted outcome for a single `run` call. */
export type ScriptedRunOutcome =
  | { readonly kind: 'ok'; readonly result: ProcessRunResult }
  | { readonly kind: 'error'; readonly error: StorageError };

/** Capture of a single `run` invocation. */
export interface CapturedRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

export class FakeProcessRunner implements ProcessRunner {
  /** All captured invocations, in call order. */
  readonly calls: CapturedRun[] = [];

  private readonly outcomes: ScriptedRunOutcome[] = [];

  /** Push a scripted ok result onto the queue. */
  enqueue(response: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }): this {
    this.outcomes.push({
      kind: 'ok',
      result: {
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
        exitCode: response.exitCode ?? 0,
      },
    });
    return this;
  }

  /** Push a scripted error onto the queue. */
  enqueueError(error: StorageError): this {
    this.outcomes.push({ kind: 'error', error });
    return this;
  }

  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<Result<ProcessRunResult, StorageError>> {
    this.calls.push({ command, args, options });
    const next = this.outcomes.shift();
    if (next === undefined) {
      // Default to a clean ok exit when callers exhaust the script.
      return Promise.resolve(Result.ok<ProcessRunResult>({ stdout: '', stderr: '', exitCode: 0 }));
    }
    if (next.kind === 'ok') return Promise.resolve(Result.ok(next.result));
    return Promise.resolve(Result.error(next.error));
  }

  /** Read the most recent captured invocation, or `undefined`. */
  lastCall(): CapturedRun | undefined {
    return this.calls.at(-1);
  }
}
