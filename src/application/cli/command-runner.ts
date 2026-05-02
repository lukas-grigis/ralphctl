/**
 * `runCommand` — shared "load deps, run command body, format output, set
 * exit code" wrapper.
 *
 * The body returns a `Result<TResult, DomainError>`; the runner formats
 * success or failure to stdout / stderr and yields a numeric exit code
 * the caller hands to `process.exit`. This keeps every CLI command file
 * down to: parse flags → call `runCommand(deps => useCase.execute(...))`.
 *
 * Workflow commands that launch a chain via `SessionManager` do their
 * own streaming; they don't go through this helper.
 */
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from './exit-codes.ts';
import { formatError } from './format/format-error.ts';

/** Format function: render the command's success value to stdout. */
export type Formatter<TResult> = (deps: SharedDeps, result: TResult) => string | undefined;

export interface RunCommandOptions<TResult> {
  readonly deps: SharedDeps;
  readonly body: (deps: SharedDeps) => Promise<Result<TResult, DomainError>>;
  readonly format?: Formatter<TResult>;
  /** Exit code returned on `Result.error`. Defaults to {@link EXIT_ERROR}. */
  readonly errorExitCode?: ExitCode;
}

/**
 * Run a command body that yields a `Result`. Logs the success via the
 * provided formatter, or formats the domain error to stderr on failure.
 */
export async function runCommand<TResult>(options: RunCommandOptions<TResult>): Promise<ExitCode> {
  const { deps, body, format, errorExitCode = EXIT_ERROR } = options;
  const result = await body(deps);
  if (!result.ok) {
    printError(deps, result.error);
    return errorExitCode;
  }
  // The Result type uses a conditional `[T] extends [never] ? undefined : T`
  // for `value`. With a generic `TResult` we can't widen it back, so cast
  // through `unknown` once at the boundary — body() guaranteed `ok` here.
  const value = result.value as unknown as TResult;
  if (format) {
    const rendered = format(deps, value);
    if (typeof rendered === 'string' && rendered.length > 0) {
      process.stdout.write(rendered + '\n');
    }
  }
  return EXIT_SUCCESS;
}

/** Render a domain error to stderr in a uniform shape. */
export function printError(deps: SharedDeps, error: DomainError): void {
  process.stderr.write(`${formatError(error)}\n`);
  // Structured log for non-TTY consumers (the JsonlSink also captures it).
  deps.logger.error('command failed', { code: error.code, message: error.message });
}

/**
 * Thin wrapper around `Parser.parse(raw)` that widens the error type to
 * `DomainError`. Lets command bodies early-return on parse failure
 * without a `Result.error(parsed.error)` re-wrap, since the body's
 * declared error type is `DomainError`:
 *
 * ```ts
 * body: async () => {
 *   const id = parseId(SprintId, opts.id);
 *   if (!id.ok) return id;
 *   return useCase.execute({ id: id.value, ... });
 * }
 * ```
 *
 * Replaces the `if (!parsed.ok) return Result.error(parsed.error)`
 * pattern repeated across ~20 CLI command files.
 */
export function parseId<T>(
  parser: { parse(raw: string): Result<T, DomainError> },
  raw: string
): Result<T, DomainError> {
  return parser.parse(raw);
}
