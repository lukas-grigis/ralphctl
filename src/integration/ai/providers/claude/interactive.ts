import { promises as fs } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveClaudeDeps } from '@src/integration/ai/providers/_engine/claude-interactive-deps.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { uuidv7 } from '@src/domain/value/uuid7.ts';

/**
 * Interactive `claude` adapter. Spawns the Claude CLI with `stdio: 'inherit'` so the user
 * sees Claude's UI directly and can type answers to its `AskUserQuestion` prompts. The
 * harness has no read-side on stdout while the user owns the terminal — Claude is told to
 * write its final answer to {@link InteractiveAiProviderInput.outputFile}, and the caller
 * reads that file back after this session resolves.
 *
 * The prompt is read from `promptFile` in Node.js and passed directly as a positional
 * argument so the Claude CLI receives it as the initial conversation message:
 *
 *   claude --add-dir <cwd> --add-dir <dirname(outputFile)> [--add-dir <extra>...]
 *          --model <model> --permission-mode acceptEdits --session-id <uuid> <prompt>
 *
 * The previous approach ran `bash -lc "claude ... \"$(cat promptFile)\""`. That broke on
 * Windows because:
 *   1. Git Bash cannot execute `claude.cmd` shims (npm/winget installs) without the .cmd
 *      extension, so the inner `claude` command exited with code 1.
 *   2. Windows paths contain backslashes which break bash path resolution inside the
 *      shell command string (`$(cat 'C:\Users\...')` is not a valid Unix path in bash).
 *
 * By reading the file in Node.js and spawning Claude directly, the bash dependency is
 * eliminated entirely. On Windows the default spawn uses `shell: true` so Node's
 * `cmd.exe /c` wrapper resolves `.cmd` / `.ps1` shims that npm and winget install.
 * On POSIX, direct spawn (no shell) is used — claude is a native binary.
 *
 * Permission strategy: `acceptEdits` auto-approves the `Edit`/`Write` tools — but ONLY for
 * paths inside one of the `--add-dir` roots. To make refine / plan / ideate "just work" for
 * the end user (no "Create file?" prompt mid-session), the adapter automatically mounts the
 * directory containing `outputFile` and the directory containing `promptFile` as additional
 * `--add-dir` roots. The harness already controls where those files live; the user
 * shouldn't have to confirm framework-internal file writes.
 *
 * Pause-the-host (Ink) is **not** the adapter's responsibility — that lives in the leaf,
 * which wraps `interactiveAi.run(...)` in `runInTerminal(...)`. Keeping the adapter pure
 * means it works the same way under TUI, plain CLI, and tests.
 *
 * Docs: https://code.claude.com/docs/en/cli-reference (`claude "query"` interactive form,
 * `--permission-mode acceptEdits`, `--add-dir`, `--model`).
 */

const defaultSpawn: InteractiveSpawn = (command, args, options) =>
  // On Windows, spawn with shell:true so Node's cmd.exe wrapper resolves .cmd shims
  // (claude.cmd / gh.cmd / codex.cmd) that npm and winget install. On POSIX, spawn
  // directly — native binaries need no shell wrapper.
  nodeSpawn(command, [...args], {
    stdio: options.stdio,
    cwd: options.cwd,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

const defaultReadFile = (path: string): Promise<string> => fs.readFile(path, 'utf8');

export const createInteractiveClaudeProvider = (deps: InteractiveClaudeDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'claude';
  const readFile = deps.readFile ?? defaultReadFile;
  const newSessionId = deps.newSessionId ?? uuidv7;

  return {
    async run(input: InteractiveAiProviderInput) {
      if (!isClaudeModel(input.model)) {
        return Result.error(
          new InvalidStateError({
            entity: 'interactive-claude',
            currentState: 'model-validation',
            attemptedAction: 'run',
            message: `interactive-claude: '${input.model}' is not a known Claude model`,
          })
        );
      }

      // Read the prompt file in Node.js so its content can be passed as a direct argv
      // element to claude. This avoids the bash $(cat ...) expansion that broke on Windows
      // (backslash paths + .cmd shim resolution issues).
      let prompt: string;
      try {
        prompt = await readFile(String(input.promptFile));
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `interactive-claude: failed to read prompt file ${String(input.promptFile)} — ${stringifyError(cause)}`,
            cause,
          })
        );
      }

      // Mount every requested root via `--add-dir`. The primary `cwd` always goes first; any
      // `additionalRoots` follow so multi-repo projects can navigate every repo (plan / refine).
      // We ALSO auto-mount `dirname(outputFile)` and `dirname(promptFile)` so the AI's writes
      // to the harness-controlled output path (e.g. requirements.md / plan.json sitting in
      // `~/.ralphctl/data/sprints/…/`) don't trigger a "Create file?" prompt mid-session.
      // The end user shouldn't see framework plumbing; the harness already controls these
      // paths, so silently allowing edits inside them is the right default. Duplicates are
      // folded out.
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

      // Pre-generate the session id and pass it via `--session-id <uuid>`. This is the
      // interactive analogue of the headless `session-id.txt` sidechannel: the parent can't read
      // the child's stdout while the user owns the terminal (stdio-inherit), but Claude's CLI
      // accepts a harness-supplied UUID at launch, so we know the id without parsing logs.
      // Persisted to `<dirname(outputFile)>/session-id.txt` post-exit and returned on success.
      const sessionId = newSessionId();

      const args = [
        ...dirFlags,
        '--model',
        input.model,
        '--permission-mode',
        'acceptEdits',
        '--session-id',
        sessionId,
        prompt,
      ];

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-claude: starting session (cwd=${String(input.cwd)})`,
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
            message: `interactive-claude: failed to spawn — ${stringifyError(cause)}`,
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
        message: `interactive-claude: session exited (code=${String(exitCode ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      if (exitCode !== 0) {
        return Result.error(
          new InvalidStateError({
            entity: 'interactive-claude',
            currentState: 'session-exit',
            attemptedAction: 'run',
            message: `interactive-claude: session exited with code ${String(exitCode ?? 'null')}`,
          })
        );
      }

      // Persist the captured session id next to `outputFile` (mirrors the headless contract,
      // which lands the file next to `signalsFile`). Best-effort: a write failure is logged
      // and ignored — the id is still returned in the Result so subscribers can correlate.
      const sidWrote = await persistSessionIdFile(input.outputFile, sessionId);
      if (sidWrote !== undefined && !sidWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: 'interactive-claude: failed to write sessionId file — resume re-attach may need log parsing',
          meta: { error: sidWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
      return Result.ok({ sessionId });
    },
  };
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
