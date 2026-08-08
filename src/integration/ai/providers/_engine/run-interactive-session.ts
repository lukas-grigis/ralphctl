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
import { argvByteLength, argvOverflowHint, isArgvOverflow } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import { buildPromptPointer, isPromptFileReachable } from '@src/integration/ai/providers/_engine/prompt-pointer.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { attachAbortKill } from '@src/integration/ai/providers/_engine/abort-kill.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { uuidv7 } from '@src/domain/value/uuid7.ts';

/**
 * Everything the per-CLI adapters used to duplicate line for line: model validation, reading the
 * prompt file, folding the mounted roots, the start / exit log pair, the `stdio: 'inherit'` spawn,
 * the abort kill-ladder, abort-before-exit-code precedence, and the session-id sidechannel.
 *
 * Each `<tool>/interactive.ts` now supplies only the parts that genuinely differ — its CLI name,
 * its model catalog, whether the CLI accepts a harness-supplied session id, and how it spells its
 * flags — via {@link InteractiveProviderSpec}. The three adapters previously drifted apart in
 * small ways (one skipped the suspension check, one hardcoded its own name in an error) precisely
 * because the skeleton was copied rather than shared.
 *
 * The prompt travels as a POINTER to the file the caller already rendered — a fixed-size argv
 * element naming the path — not as the body. Passing the body inlined argv size to prompt size,
 * and the interactive templates outgrew the Windows command-line ceiling: a plan session died with
 * `spawn ENAMETOOLONG` before Claude ever started. See `prompt-pointer.ts` for the pointer and
 * `argv-budget.ts` for the limits. The one exception is a CLI that cannot be given access to the
 * prompt file (OpenCode with a prompt outside `cwd`), which falls back to the inlined body with a
 * warning rather than opening a session that can read nothing.
 *
 * The binary is spawned directly through `crossPlatformSpawn`, which resolves the npm / winget
 * `.cmd` shims and escapes arguments containing spaces or `& | % "` without a shell. Neither a
 * `bash -lc "… $(cat promptFile)"` wrapper nor `shell: true` may come back: the first cannot
 * execute `.cmd` shims, mangles Windows backslash paths inside `$(cat …)`, and silently dropped
 * the seeded prompt on Copilot; the second mis-quotes exactly the arguments listed above.
 *
 * Pause-the-host (Ink) is not the adapter's responsibility — that lives in the leaf, which wraps
 * `interactiveAi.run(...)` in `runInTerminal(...)`. Keeping the adapter pure means it behaves the
 * same under the TUI, the plain CLI, and tests.
 */
export interface InteractiveSessionContext {
  /**
   * What goes in the CLI's prompt slot: normally a short pointer at `input.promptFile`
   * ({@link buildPromptPointer}), and only when that file would be unreachable — OpenCode with a
   * prompt outside `cwd` — the prompt body itself. Adapters place it verbatim; the decision is the
   * engine's so no adapter can reintroduce an unbounded argv element on its own.
   */
  readonly promptArg: string;
  /**
   * Directory roots to mount, de-duplicated and ordered: `cwd`, then any `additionalRoots`, then
   * the directories holding `outputFile` and `promptFile`. Each CLI spells the flag differently
   * (`--add-dir <path>` vs `--add-dir=<path>`), so formatting stays with the spec.
   */
  readonly roots: readonly string[];
  /**
   * Pre-generated session id, present only when the spec sets `supportsSessionId`. This is the
   * interactive analogue of the headless `session-id.txt` sidechannel: the parent cannot read the
   * child's stdout while the user owns the terminal, but CLIs that accept a harness-supplied UUID
   * at launch let the harness know the id without parsing logs.
   */
  readonly sessionId: string | undefined;
}

export interface InteractiveProviderSpec {
  /** Entity / element name stamped on every error and log line this adapter surfaces. */
  readonly providerName: string;
  /** Binary invoked when the caller supplies no `command` override. */
  readonly defaultCommand: string;
  /** Human-facing catalog name used in the unknown-model message, e.g. `'Claude'`. */
  readonly modelCatalogLabel: string;
  /** Catalog-membership predicate for the CLI's model ids. */
  readonly isKnownModel: (model: string) => boolean;
  /**
   * Whether the CLI accepts a harness-supplied session id at launch. Claude
   * (`--session-id <uuid>`) and Copilot (`--session-id=<uuid>`) do; Codex's only `--session-id`
   * lives on its `resume` / `fork` subcommands and is a lookup key for an existing session, not a
   * "use this UUID" override — so Codex leaves the field unset and the port contract treats the
   * absence as non-fatal.
   */
  readonly supportsSessionId: boolean;
  /**
   * Whether the CLI can be handed directory roots (`--add-dir` or equivalent), which decides
   * whether the prompt file is reachable from wherever the harness put it. Claude / Copilot /
   * Codex can; OpenCode cannot — its single positional project directory is the whole topology —
   * so it only sees a prompt file that already lives under `cwd`. Drives the pointer-vs-body
   * decision in {@link isPromptFileReachable}.
   */
  readonly mountsRoots: boolean;
  /**
   * Environment entries this CLI needs at launch, layered over the harness's own environment.
   * Present only for a CLI configured through the environment rather than through flags —
   * OpenCode, which receives its prompt-directory grant this way because it has no `--add-dir`.
   */
  readonly buildEnv?: (input: InteractiveAiProviderInput) => Readonly<Record<string, string>>;
  /** Assemble the CLI's argv from the caller's input plus the shared session context. */
  readonly buildArgs: (input: InteractiveAiProviderInput, context: InteractiveSessionContext) => readonly string[];
}

/**
 * Mount `cwd`, every caller-declared `additionalRoots` entry, and the directories holding the
 * prompt / output files. The harness controls where those files live (e.g. `requirements.md`
 * under `~/.ralphctl/data/sprints/…`), and the CLIs only auto-approve writes inside a mounted
 * root — without this the user gets a "Create file?" prompt for framework plumbing mid-session.
 * Duplicates (prompt and output usually share a directory) are folded out.
 */
const dedupeRoots = (input: InteractiveAiProviderInput): readonly string[] => {
  const all = [
    String(input.cwd),
    ...(input.additionalRoots?.map((r) => String(r)) ?? []),
    dirname(String(input.outputFile)),
    dirname(String(input.promptFile)),
  ];
  return [...new Set(all)];
};

/**
 * Decide what occupies the CLI's prompt slot. Normally the pointer; the body only when the CLI
 * could not open the file it points at, which today means OpenCode running with the prompt outside
 * `cwd` (ideate, memory-distill). The fallback is warned about rather than silent — it is the one
 * remaining path where a large prompt can still overflow argv, so an operator hitting the limit
 * there gets the size in the log rather than only an errno at spawn time.
 */
const resolvePromptArg = (
  deps: InteractiveProviderDeps,
  spec: InteractiveProviderSpec,
  input: InteractiveAiProviderInput,
  body: string
): string => {
  const promptFile = String(input.promptFile);
  if (isPromptFileReachable(String(input.cwd), promptFile, spec.mountsRoots)) return buildPromptPointer(promptFile);

  deps.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${spec.providerName}: prompt file is outside the session's only readable root — passing the prompt inline (${String(Buffer.byteLength(body, 'utf8'))} bytes)`,
    meta: { promptFile, cwd: String(input.cwd) },
    at: IsoTimestamp.now(),
  });
  return body;
};

/** Read the rendered prompt off disk, mapping any read failure to a `StorageError`. */
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

/**
 * Describe a spawn failure. An argv overflow gets named as such — it used to surface as a bare
 * `failed to spawn — spawn ENAMETOOLONG` with nothing pointing at the cause, and the errno alone
 * is not enough to recognise it (the same condition has been seen arriving as
 * `ERROR_INVALID_PARAMETER`), so the measured byte count decides too.
 */
const describeSpawnFailure = (providerName: string, cause: unknown, argvBytes: number, promptFile: string): string => {
  const errno = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.name) : undefined;
  if (!isArgvOverflow(errno, argvBytes)) return `${providerName}: failed to spawn — ${messageOf(cause)}`;
  return `${providerName}: failed to spawn — ${messageOf(cause)} — ${argvOverflowHint(argvBytes, promptFile)}`;
};

/** Hand the terminal to the CLI. A throwing spawn (missing binary, EACCES) becomes a `StorageError`. */
const spawnSession = (
  spawnFn: InteractiveSpawn,
  command: string,
  args: readonly string[],
  input: InteractiveAiProviderInput,
  providerName: string,
  env: Readonly<Record<string, string>> | undefined
): Result<ChildProcess, StorageError> => {
  try {
    return Result.ok(
      spawnFn(command, args, { stdio: 'inherit', cwd: String(input.cwd), ...(env !== undefined ? { env } : {}) })
    );
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: describeSpawnFailure(providerName, cause, argvByteLength(command, args), String(input.promptFile)),
        cause,
      })
    );
  }
};

/** How a session ended: an exit code, or the spawn-level failure that arrived asynchronously. */
interface SessionExit {
  readonly code: number | null;
  readonly spawnError?: unknown;
}

/**
 * Run the child to completion under the abort kill-ladder. A `stdio: 'inherit'` child is
 * unreachable once spawned (the harness keeps no reference past `run`), so a TUI-side cancel can't
 * stop it — the caller's abort signal drives a SIGTERM → grace → SIGKILL ladder instead, and the
 * cleanup runs on normal exit so a reused AbortController never fires kill against a dead pid.
 *
 * An `error` event is a spawn-level failure that surfaced after launch rather than as a throw. Its
 * cause is carried out rather than collapsed into the `-1` code alone: an argv overflow can arrive
 * on either path, and reporting one of them as `session exited with code -1` hid the real cause.
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

/**
 * Classify a finished session, or `undefined` when it succeeded.
 *
 * Abort takes precedence over the exit code (mirrors `classifySpawnExit`): a user cancel tore the
 * child down via the kill ladder's SIGTERM, so the non-zero exit IS the cancel rather than a
 * session error. `AbortError` — the one error chains propagate transparently — has to win over the
 * `InvalidStateError` shape a downstream guard could catch and continue past.
 */
const classifyExit = (
  providerName: string,
  abortSignal: AbortSignal | undefined,
  exitCode: number | null
): AbortError | InvalidStateError | undefined => {
  if (abortSignal?.aborted === true) {
    return new AbortError({ elementName: providerName, reason: `${providerName}: aborted by caller` });
  }
  if (exitCode === 0) return undefined;
  return new InvalidStateError({
    entity: providerName,
    currentState: 'session-exit',
    attemptedAction: 'run',
    message: `${providerName}: session exited with code ${String(exitCode ?? 'null')}`,
  });
};

/**
 * Mirror the session id next to `outputFile` (the interactive counterpart of the headless
 * contract, which lands the file next to `signalsFile`). Best-effort: a write failure is logged
 * and ignored — the id still comes back in the Result so subscribers can correlate.
 */
const mirrorSessionId = async (
  deps: InteractiveProviderDeps,
  providerName: string,
  input: InteractiveAiProviderInput,
  sessionId: string
): Promise<void> => {
  const wrote = await persistSessionIdFile(input.outputFile, sessionId);
  if (wrote === undefined || wrote.ok) return;
  deps.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${providerName}: failed to write sessionId file — resume re-attach may need log parsing`,
    meta: { error: wrote.error.message },
    at: IsoTimestamp.now(),
  });
};

export const createInteractiveProvider = (
  spec: InteractiveProviderSpec,
  deps: InteractiveProviderDeps
): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultInteractiveSpawn;
  const command = deps.command ?? spec.defaultCommand;
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

      // Read-through even though the body no longer reaches argv: it is the pre-flight that turns
      // a missing / unreadable prompt file into a clear error before the terminal is handed over,
      // and it supplies the body for the unreachable-file fallback below.
      const prompt = await readPrompt(readFile, input, spec.providerName);
      if (!prompt.ok) return Result.error(prompt.error);

      const promptArg = resolvePromptArg(deps, spec, input, prompt.value);
      const sessionId = spec.supportsSessionId ? newSessionId() : undefined;
      const args = spec.buildArgs(input, { promptArg, roots: dedupeRoots(input), sessionId });

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

      const spawned = spawnSession(spawnFn, command, args, input, spec.providerName, spec.buildEnv?.(input));
      if (!spawned.ok) return Result.error(spawned.error);

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
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: describeSpawnFailure(
              spec.providerName,
              exit.spawnError,
              argvByteLength(command, args),
              String(input.promptFile)
            ),
            cause: exit.spawnError,
          })
        );
      }

      const failure = classifyExit(spec.providerName, input.abortSignal, exit.code);
      if (failure !== undefined) return Result.error(failure);

      if (sessionId === undefined) return Result.ok({});
      await mirrorSessionId(deps, spec.providerName, input, sessionId);
      return Result.ok({ sessionId });
    },
  };
};
