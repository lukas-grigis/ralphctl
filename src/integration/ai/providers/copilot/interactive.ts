import { type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveCopilotDeps } from '@src/integration/ai/providers/_engine/copilot-interactive-deps.ts';
import {
  type InteractiveSpawn,
  defaultInteractiveSpawn,
  defaultReadFile,
} from '@src/integration/ai/providers/_engine/interactive-spawn.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { attachAbortKill } from '@src/integration/ai/providers/_engine/abort-kill.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { uuidv7 } from '@src/domain/value/uuid7.ts';

/**
 * Interactive `copilot` adapter. Spawns the GitHub Copilot CLI with `stdio: 'inherit'` so the
 * user sees the TUI directly. The harness has no read-side on stdout while the user owns the
 * terminal, so the prompt tells Copilot to write its final answer to
 * {@link InteractiveAiProviderInput.outputFile}, and the caller reads that file back after this
 * session resolves.
 *
 * Copilot's interactive form supports a pre-seeded prompt via `-i PROMPT` / `--interactive
 * =PROMPT`. The adapter reads the prompt file in Node and passes the content **directly as
 * argv** — no `bash -lc`, no `$(cat …)` substitution. The previous shell-wrapping form
 * silently dropped the seeded prompt for some users (TUI started at the empty input box),
 * and v1's working copilot adapter spawns the binary directly with `['-i', prompt]` — so
 * v2 now matches that pattern.
 *
 * We use `--add-dir=PATH` / `--model=MODEL` to keep argv construction deterministic.
 *
 * Permission strategy: `--allow-all-tools` so the AI doesn't get blocked on per-tool
 * confirmation prompts (read, search, shell) before it can consume the seeded prompt. The
 * user still owns the terminal session and can stop the AI at any time; the harness's
 * read-side is post-session (output file).
 *
 * The directory containing `outputFile` (and the prompt-file dir) is auto-added via
 * `--add-dir` so the harness-internal write lands inside an allowed root.
 *
 * Pause-the-host (Ink) is **not** the adapter's responsibility — that lives in the leaf.
 *
 * Docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 */

/** Entity / element name stamped on every error this adapter surfaces. */
const PROVIDER = 'interactive-copilot';

export const createInteractiveCopilotProvider = (deps: InteractiveCopilotDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultInteractiveSpawn;
  const command = deps.command ?? 'copilot';
  const readFile = deps.readFile ?? defaultReadFile;
  const newSessionId = deps.newSessionId ?? uuidv7;

  return {
    async run(input: InteractiveAiProviderInput) {
      if (!isCopilotModel(input.model)) {
        return Result.error(
          new InvalidStateError({
            entity: PROVIDER,
            currentState: 'model-validation',
            attemptedAction: 'run',
            message: `interactive-copilot: '${input.model}' is not a known Copilot model`,
          })
        );
      }

      let prompt: string;
      try {
        prompt = await readFile(String(input.promptFile));
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `interactive-copilot: failed to read prompt file ${String(input.promptFile)} — ${stringifyError(cause)}`,
            cause,
          })
        );
      }

      // Mount cwd + any explicit additionalRoots + the dirs that hold the prompt/output
      // files so the AI can read/write those harness-owned paths without per-file
      // confirmation prompts.
      const allRoots = [
        String(input.cwd),
        ...(input.additionalRoots?.map((r) => String(r)) ?? []),
        dirname(String(input.outputFile)),
        dirname(String(input.promptFile)),
      ];
      const seen = new Set<string>();
      // Emit `--add-dir=...` / `--model=...` for deterministic argv construction.
      const dirFlags = allRoots
        .filter((p) => {
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        })
        .map((p) => `--add-dir=${p}`);

      // Pre-generate the session id and pass it via `--session-id=<uuid>`. Mirrors the
      // headless `session-id.txt` sidechannel: the parent can't read the child's stdout while
      // the user owns the terminal (stdio-inherit), but Copilot's CLI accepts a harness-supplied
      // id at launch, so we know it without parsing logs. Persisted next to `outputFile`
      // post-exit and returned on success.
      const sessionId = newSessionId();

      const args = [
        ...dirFlags,
        `--model=${input.model}`,
        '--allow-all-tools',
        `--session-id=${sessionId}`,
        '-i',
        prompt,
      ];

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-copilot: starting session (cwd=${String(input.cwd)})`,
        meta: { promptFile: String(input.promptFile), outputFile: String(input.outputFile), sessionId },
        at: IsoTimestamp.now(),
      });

      let child: ChildProcess;
      try {
        child = spawnFn(command, args, { stdio: 'inherit', cwd: String(input.cwd) });
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `interactive-copilot: failed to spawn — ${stringifyError(cause)}`,
            cause,
          })
        );
      }

      // A `stdio: 'inherit'` child is unreachable once spawned (the harness keeps no reference
      // past `run`), so a TUI-side cancel can't stop it. Wire the caller's abort signal to a
      // SIGTERM → grace → SIGKILL kill ladder; the cleanup runs on normal exit so a reused
      // AbortController never fires kill against the dead pid.
      const stopAbortKill = attachAbortKill(child, input.abortSignal);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(-1));
      });
      stopAbortKill();

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-copilot: session exited (code=${String(exitCode ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      // Abort precedence (mirrors classifySpawnExit step 1). A user cancel (Ctrl-C / TUI stop)
      // tore the child down via attachAbortKill's SIGTERM, so the non-zero exit below is the
      // cancel — not a session error. Surface AbortError (the one error chains propagate
      // transparently, CLAUDE.md §AbortError) BEFORE the exit-code branch, so a downstream
      // guard/fallback doesn't catch an InvalidStateError shape and continue past the cancel.
      if (input.abortSignal?.aborted === true) {
        return Result.error(
          new AbortError({
            elementName: PROVIDER,
            reason: `${PROVIDER}: aborted by caller`,
          })
        );
      }

      if (exitCode !== 0) {
        return Result.error(
          new InvalidStateError({
            entity: PROVIDER,
            currentState: 'session-exit',
            attemptedAction: 'run',
            message: `interactive-copilot: session exited with code ${String(exitCode ?? 'null')}`,
          })
        );
      }

      const sidWrote = await persistSessionIdFile(input.outputFile, sessionId);
      if (sidWrote !== undefined && !sidWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: 'interactive-copilot: failed to write sessionId file — resume re-attach may need log parsing',
          meta: { error: sidWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
      return Result.ok({ sessionId });
    },
  };
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
