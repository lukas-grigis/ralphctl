import { type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import {
  type InteractiveSpawn,
  defaultInteractiveSpawn,
  defaultReadFile,
} from '@src/integration/ai/providers/_engine/interactive-spawn.ts';
import {
  argvByteLength,
  argvOverflowHint,
  errnoOf,
  isArgvOverflow,
} from '@src/integration/ai/providers/_engine/argv-budget.ts';
import { buildPromptPointer } from '@src/integration/ai/providers/_engine/prompt-pointer.ts';
import { persistSessionIdBestEffort } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { attachAbortKill } from '@src/integration/ai/providers/_engine/abort-kill.ts';
import { recordSpawnContext } from '@src/integration/ai/providers/_engine/spawn-context-probe.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { abortedByCaller } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { uuidv7 } from '@src/domain/value/uuid7.ts';

/**
 * The shared interactive-session skeleton: model validation, prompt pre-flight, root folding, the
 * start / exit logs, the `stdio: 'inherit'` spawn, the abort kill-ladder and the session-id
 * sidechannel. Each `<tool>/interactive.ts` supplies only an {@link InteractiveProviderSpec}.
 *
 * The prompt travels as a POINTER at the rendered file, never the body — the body outgrew the
 * Windows argv ceiling (`prompt-pointer.ts`, `argv-budget.ts`). The binary is spawned directly
 * through `crossPlatformSpawn`; never wrap it in `bash -lc "… $(cat promptFile)"` or `shell: true`
 * (see `.claude/docs/SECURITY.md`).
 *
 * Handing over the terminal is the caller's job: release `process.stdin` first
 * (`releaseStdinForChild`, as `runInTerminal` does), or the parent eats the terminal's replies to
 * the child's capability queries and the child hangs on a black screen. See
 * `.claude/docs/INTERACTIVE-HANDOFF-HANG.md`.
 */
export interface InteractiveSessionContext {
  /** A pointer at `input.promptFile`, never the body; adapters place it verbatim. */
  readonly promptArg: string;
  /** Roots to mount, de-duplicated: `cwd`, `additionalRoots`, then the output and prompt directories. */
  readonly roots: readonly string[];
  /**
   * Pre-generated id when the spec sets `supportsSessionId` — the parent cannot read the child's
   * stdout while the user owns the terminal, so the harness picks the id up front.
   */
  readonly sessionId: string | undefined;
}

export interface InteractiveProviderSpec {
  /** Entity / element name stamped on every error and log line this adapter surfaces. */
  readonly providerName: string;
  /** Whose `PROVIDER_TRAITS` binary is spawned when the caller supplies no `command` override. */
  readonly provider: AiProvider;
  /** Human-facing catalog name used in the unknown-model message, e.g. `'Claude'`. */
  readonly modelCatalogLabel: string;
  /** Catalog-membership predicate for the CLI's model ids. */
  readonly isKnownModel: (model: string) => boolean;
  /** Whether the CLI accepts a harness-chosen session id at launch (codex's `--session-id` only looks one up). */
  readonly supportsSessionId: boolean;
  /**
   * Environment overlay for a CLI granted access through the environment (OpenCode has no
   * `--add-dir`). It must grant every root in `context.roots`, and return `InvalidStateError` for a
   * root it cannot express rather than quietly granting less; a refusal stops before the start log
   * and the spawn.
   */
  readonly buildEnv?: (
    input: InteractiveAiProviderInput,
    context: InteractiveSessionContext
  ) => Result<Readonly<Record<string, string>>, DomainError>;
  /** Assemble the CLI's argv from the caller's input plus the shared session context. */
  readonly buildArgs: (input: InteractiveAiProviderInput, context: InteractiveSessionContext) => readonly string[];
}

// The CLIs only auto-approve writes inside a mounted root; unmounted harness files would prompt "Create file?".
const dedupeRoots = (input: InteractiveAiProviderInput): readonly string[] => {
  const all = [
    String(input.cwd),
    ...(input.additionalRoots?.map((r) => String(r)) ?? []),
    dirname(String(input.outputFile)),
    dirname(String(input.promptFile)),
  ];
  return [...new Set(all)];
};

const buildSessionEnv = (
  spec: InteractiveProviderSpec,
  input: InteractiveAiProviderInput,
  context: InteractiveSessionContext
): Result<Readonly<Record<string, string>> | undefined, DomainError> =>
  spec.buildEnv === undefined ? Result.ok(undefined) : spec.buildEnv(input, context);

/**
 * Pre-flight read (contents discarded; the CLI reads the file itself) so a missing or unreadable
 * prompt fails BEFORE the terminal is handed over. A `stat` would pass on EACCES.
 */
const readPrompt = async (
  readFile: (path: string) => Promise<string>,
  input: InteractiveAiProviderInput,
  providerName: string
): Promise<Result<string, StorageError>> => {
  try {
    return Result.ok(await readFile(String(input.promptFile)));
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${providerName}: failed to read prompt file ${String(input.promptFile)} — ${messageOf(cause)}`,
        cause,
      })
    );
  }
};

/** Names an argv overflow as such; the errno alone can't (it also arrives as `ERROR_INVALID_PARAMETER`). */
const spawnFailure = (
  providerName: string,
  cause: unknown,
  command: string,
  args: readonly string[],
  promptFile: string
): StorageError => {
  const argvBytes = argvByteLength(command, args);
  const overflow = isArgvOverflow(errnoOf(cause), argvBytes) ? ` — ${argvOverflowHint(argvBytes, promptFile)}` : '';
  return new StorageError({
    subCode: 'io',
    message: `${providerName}: failed to spawn — ${messageOf(cause)}${overflow}`,
    cause,
  });
};

/** A throwing spawn surfaces its raw cause, so it reports exactly like the async `'error'` event. */
const spawnSession = (
  spawnFn: InteractiveSpawn,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> | undefined
): Result<ChildProcess, unknown> => {
  try {
    return Result.ok(spawnFn(command, args, { stdio: 'inherit', cwd, ...(env !== undefined ? { env } : {}) }));
  } catch (cause) {
    return Result.error(cause);
  }
};

/** How a session ended: an exit code, or the spawn-level failure that arrived asynchronously. */
interface SessionExit {
  readonly code: number | null;
  readonly spawnError?: unknown;
}

/**
 * The caller's abort signal drives the SIGTERM → grace → SIGKILL ladder; it is detached on exit so a
 * reused AbortController never signals a dead pid. An `'error'` event carries its cause out rather
 * than collapsing into a bare `-1`.
 */
const awaitExit = async (child: ChildProcess, abortSignal: AbortSignal | undefined): Promise<SessionExit> => {
  const stopAbortKill = attachAbortKill(child, abortSignal);
  const exit = await new Promise<SessionExit>((resolve) => {
    child.on('close', (code) => resolve({ code }));
    child.on('error', (cause) => resolve({ code: -1, spawnError: cause }));
  });
  stopAbortKill();
  return exit;
};

/** `undefined` on success. Abort beats the exit code: the non-zero exit IS the cancel's SIGTERM. */
const classifyExit = (
  providerName: string,
  abortSignal: AbortSignal | undefined,
  exitCode: number | null
): AbortError | InvalidStateError | undefined => {
  if (abortSignal?.aborted === true) return abortedByCaller(providerName);
  if (exitCode === 0) return undefined;
  return new InvalidStateError({
    entity: providerName,
    currentState: 'session-exit',
    attemptedAction: 'run',
    message: `${providerName}: session exited with code ${String(exitCode ?? 'null')}`,
  });
};

export const createInteractiveProvider = (
  spec: InteractiveProviderSpec,
  deps: InteractiveProviderDeps
): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultInteractiveSpawn;
  const command = deps.command ?? PROVIDER_TRAITS[spec.provider].binary;
  const readFile = deps.readFile ?? defaultReadFile;
  const newSessionId = deps.newSessionId ?? uuidv7;

  return {
    async run(input: InteractiveAiProviderInput) {
      const validated = validateModel(input.model, spec.isKnownModel, {
        entity: spec.providerName,
        attemptedAction: 'run',
        notKnownMessage: `${spec.providerName}: '${input.model}' is not a known ${spec.modelCatalogLabel} model`,
      });
      if (!validated.ok) return Result.error(validated.error);

      const prompt = await readPrompt(readFile, input, spec.providerName);
      if (!prompt.ok) return Result.error(prompt.error);

      const promptArg = buildPromptPointer(String(input.promptFile));
      const sessionId = spec.supportsSessionId ? newSessionId() : undefined;
      // ONE context for both hooks, so argv flags and environment grants describe the same roots.
      const context: InteractiveSessionContext = { promptArg, roots: dedupeRoots(input), sessionId };
      const args = spec.buildArgs(input, context);

      // Before the start log, so a refused grant never logs a session that was never started.
      const env = buildSessionEnv(spec, input, context);
      if (!env.ok) return Result.error(env.error);

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `${spec.providerName}: starting session (cwd=${String(input.cwd)})`,
        meta: {
          promptFile: String(input.promptFile),
          outputFile: String(input.outputFile),
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
        at: IsoTimestamp.now(),
      });

      // Last observable moment: `stdio: 'inherit'` hands the terminal to the child, after which
      // the harness sees nothing. Synchronous, so a child that freezes instantly cannot outrun it.
      recordSpawnContext({
        providerName: spec.providerName,
        command,
        args,
        cwd: String(input.cwd),
        outputFile: String(input.outputFile),
        envOverrides: env.value,
      });

      const spawned = spawnSession(spawnFn, command, args, String(input.cwd), env.value);
      if (!spawned.ok) {
        return Result.error(spawnFailure(spec.providerName, spawned.error, command, args, String(input.promptFile)));
      }

      const exit = await awaitExit(spawned.value, input.abortSignal);

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `${spec.providerName}: session exited (code=${String(exit.code ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      // A late spawn failure outranks the synthetic `-1`, but not an abort — a user cancel that
      // races the child's teardown must still propagate as AbortError.
      if (exit.spawnError !== undefined && input.abortSignal?.aborted !== true) {
        return Result.error(spawnFailure(spec.providerName, exit.spawnError, command, args, String(input.promptFile)));
      }

      const failure = classifyExit(spec.providerName, input.abortSignal, exit.code);
      if (failure !== undefined) return Result.error(failure);

      if (sessionId === undefined) return Result.ok({});
      // Interactive counterpart of the headless contract: the id lands next to `outputFile`, not `signalsFile`.
      await persistSessionIdBestEffort(deps.eventBus, spec.providerName, input.outputFile, sessionId);
      return Result.ok({ sessionId });
    },
  };
};
