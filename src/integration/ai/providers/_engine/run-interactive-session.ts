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
 * The prompt is read in Node and handed to the CLI as a plain argv element rather than through a
 * `bash -lc "… $(cat promptFile)"` wrapper. That wrapper broke on Windows twice over: Git Bash
 * cannot execute the `.cmd` shims npm/winget install, and Windows backslash paths do not survive
 * bash path resolution inside a command string. Spawning the binary directly through
 * `crossPlatformSpawn` resolves the shim and escapes a prompt containing spaces or `& | % "`
 * without a shell.
 *
 * Pause-the-host (Ink) is not the adapter's responsibility — that lives in the leaf, which wraps
 * `interactiveAi.run(...)` in `runInTerminal(...)`. Keeping the adapter pure means it behaves the
 * same under the TUI, the plain CLI, and tests.
 */
export interface InteractiveSessionContext {
  /** Prompt-file contents, already read from disk. */
  readonly prompt: string;
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

/** Hand the terminal to the CLI. A throwing spawn (missing binary, EACCES) becomes a `StorageError`. */
const spawnSession = (
  spawnFn: InteractiveSpawn,
  command: string,
  args: readonly string[],
  cwd: string,
  providerName: string
): Result<ChildProcess, StorageError> => {
  try {
    return Result.ok(spawnFn(command, args, { stdio: 'inherit', cwd }));
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${providerName}: failed to spawn — ${messageOf(cause)}`,
        cause,
      })
    );
  }
};

/**
 * Run the child to completion under the abort kill-ladder. A `stdio: 'inherit'` child is
 * unreachable once spawned (the harness keeps no reference past `run`), so a TUI-side cancel can't
 * stop it — the caller's abort signal drives a SIGTERM → grace → SIGKILL ladder instead, and the
 * cleanup runs on normal exit so a reused AbortController never fires kill against a dead pid.
 * An `error` event (spawn-level failure after launch) maps to `-1`.
 */
const awaitExit = async (child: ChildProcess, abortSignal: AbortSignal | undefined): Promise<number | null> => {
  const stopAbortKill = attachAbortKill(child, abortSignal);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  stopAbortKill();
  return exitCode;
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

      const prompt = await readPrompt(readFile, input, spec.providerName);
      if (!prompt.ok) return Result.error(prompt.error);

      const sessionId = spec.supportsSessionId ? newSessionId() : undefined;
      const args = spec.buildArgs(input, { prompt: prompt.value, roots: dedupeRoots(input), sessionId });

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

      const spawned = spawnSession(spawnFn, command, args, String(input.cwd), spec.providerName);
      if (!spawned.ok) return Result.error(spawned.error);

      const exitCode = await awaitExit(spawned.value, input.abortSignal);

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `${spec.providerName}: session exited (code=${String(exitCode ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      const failure = classifyExit(spec.providerName, input.abortSignal, exitCode);
      if (failure !== undefined) return Result.error(failure);

      if (sessionId === undefined) return Result.ok({});
      await mirrorSessionId(deps, spec.providerName, input, sessionId);
      return Result.ok({ sessionId });
    },
  };
};
