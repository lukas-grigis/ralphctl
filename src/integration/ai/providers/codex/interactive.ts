import { promises as fs } from 'node:fs';
import { type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { Result } from '@src/domain/result.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveCodexDeps } from '@src/integration/ai/providers/_engine/codex-interactive-deps.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';

/**
 * Interactive `codex` adapter. Spawns the Codex CLI with `stdio: 'inherit'` so the user sees
 * the TUI directly and can chat. Mirrors the Claude interactive adapter — the harness has no
 * read-side on stdout while the user owns the terminal, so we tell Codex (via the prompt
 * body) to write its final answer to {@link InteractiveAiProviderInput.outputFile}, and the
 * caller reads that file back after this session resolves.
 *
 * Codex's top-level (non-`exec`) command starts the TUI and accepts an optional positional
 * prompt — `codex "explain this codebase"`. The prompt is read from `promptFile` in Node.js
 * and passed directly as a positional argument. `-s workspace-write -a never` matches
 * Claude's `--permission-mode acceptEdits` intent: file writes inside the workspace run
 * without a confirmation step (so the AI can drop its answer in `outputFile`).
 *
 * The previous approach ran `bash -lc "codex ... \"$(cat promptFile)\""`. That broke on
 * Windows because:
 *   1. Git Bash cannot execute `codex.cmd` shims (npm/winget installs) without the .cmd
 *      extension, so the inner `codex` command exited with code 1.
 *   2. Windows paths contain backslashes which break bash path resolution inside the
 *      shell command string (`$(cat 'C:\Users\...')` is not a valid Unix path in bash).
 *
 * By reading the file in Node.js and spawning Codex directly, the bash dependency is
 * eliminated. The spawn routes through `crossPlatformSpawn` (cross-spawn), which resolves
 * `codex.cmd` / `.ps1` shims on Windows and escapes the positional prompt argument correctly
 * without a shell — so a prompt containing spaces or `& | % "` round-trips safely.
 *
 * Audit [09]: harness-driven sessions want zero per-tool noise. `-a never` makes the sandbox
 * the only gate — anything outside the workspace fails immediately rather than prompting,
 * which is the correct behaviour because the harness pre-configures every legal write path
 * via cwd + `--add-dir`.
 *
 * Pause-the-host (Ink) is **not** the adapter's responsibility — that lives in the leaf,
 * which wraps `interactiveAi.run(...)` in `runInTerminal(...)`.
 *
 * Docs: https://developers.openai.com/codex/cli/reference (top-level `codex` flags).
 */

const defaultSpawn: InteractiveSpawn = (command, args, options) =>
  // Route through the shared cross-platform primitive so `codex.cmd` shims resolve on
  // Windows and the positional prompt argument is escaped correctly — without a shell.
  // See cross-platform-spawn.ts.
  crossPlatformSpawn(command, args, { stdio: options.stdio, cwd: options.cwd });

const defaultReadFile = (path: string): Promise<string> => fs.readFile(path, 'utf8');

export const createInteractiveCodexProvider = (deps: InteractiveCodexDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'codex';
  const readFile = deps.readFile ?? defaultReadFile;

  return {
    async run(input: InteractiveAiProviderInput) {
      if (!isCodexModel(input.model)) {
        return Result.error(
          new InvalidStateError({
            entity: 'interactive-codex',
            currentState: 'model-validation',
            attemptedAction: 'run',
            message: `interactive-codex: '${input.model}' is not a known Codex model`,
          })
        );
      }

      // Read the prompt file in Node.js so its content can be passed as a direct argv
      // element to codex. This avoids the bash $(cat ...) expansion that broke on Windows
      // (backslash paths + .cmd shim resolution issues).
      let prompt: string;
      try {
        prompt = await readFile(String(input.promptFile));
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `interactive-codex: failed to read prompt file ${String(input.promptFile)} — ${stringifyError(cause)}`,
            cause,
          })
        );
      }

      // Multi-repo plan mounts every project repository through `additionalRoots`. Codex
      // accepts repeated `--add-dir <DIR>` exactly like the headless variant; without this the
      // session is sandboxed to `--cd` alone and the AI can't navigate outside it. We also
      // auto-mount the dirs that hold the prompt / output files so harness-internal writes land
      // inside an allowed root without prompting — mirrors Claude's interactive adapter.
      // Duplicates (e.g. when prompt/output already sit inside cwd) are folded out.
      const allRoots = [
        String(input.cwd),
        ...(input.additionalRoots?.map((r) => String(r)) ?? []),
        dirname(String(input.outputFile)),
        dirname(String(input.promptFile)),
      ];
      const seen = new Set<string>();
      const dirFlags = allRoots
        .filter((p) => {
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        })
        .flatMap((p) => ['--add-dir', p]);

      const args = [
        '--cd',
        String(input.cwd),
        ...dirFlags,
        '--model',
        input.model,
        '-s',
        'workspace-write',
        '-a',
        'never',
        prompt,
      ];

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-codex: starting session (cwd=${String(input.cwd)})`,
        meta: { promptFile: String(input.promptFile), outputFile: String(input.outputFile) },
        at: IsoTimestamp.now(),
      });

      let child: ChildProcess;
      try {
        child = spawnFn(command, args, { stdio: 'inherit', cwd: String(input.cwd) });
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `interactive-codex: failed to spawn — ${stringifyError(cause)}`,
            cause,
          })
        );
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(-1));
      });

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-codex: session exited (code=${String(exitCode ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      // Codex's top-level (interactive) command does not accept a harness-supplied session id at
      // launch — its only `--session-id` lives on `resume` / `fork` subcommands and is treated as
      // a lookup key for an existing session, not a "use this UUID for the new conversation"
      // override. Claude (`--session-id <uuid>`) and Copilot (`--session-id=<uuid>`) both ship
      // that override and use it via the headless `session-id.txt` sidechannel; Codex
      // intentionally leaves `sessionId` unset on success. Per the InteractiveAiProvider port
      // contract, absence is non-fatal — subscribers that need a session correlation key fall
      // back to the runner's session id from `AsyncLocalStorage`.
      if (exitCode === 0) return Result.ok({});
      return Result.error(
        new InvalidStateError({
          entity: 'interactive-codex',
          currentState: 'session-exit',
          attemptedAction: 'run',
          message: `interactive-codex: session exited with code ${String(exitCode ?? 'null')}`,
        })
      );
    },
  };
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
