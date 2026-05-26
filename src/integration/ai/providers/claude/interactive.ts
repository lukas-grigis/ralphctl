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
 * The Claude CLI accepts the prompt as a positional argument. We pass the prompt FILE path
 * via shell-style command substitution so very large prompts don't blow the argv length
 * limit. Concretely we invoke:
 *
 *   claude --add-dir <cwd> --add-dir <dirname(outputFile)> [--add-dir <extra>...]
 *          --model <model> --permission-mode acceptEdits "$(cat <promptFile>)"
 *
 * via `bash -lc`. This keeps the adapter portable: no need for the Claude CLI to support a
 * `--prompt-file` flag.
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
  nodeSpawn(command, [...args], { stdio: options.stdio, cwd: options.cwd });

export const createInteractiveClaudeProvider = (deps: InteractiveClaudeDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'bash';
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
        .flatMap((p) => ['--add-dir', shellQuote(p)]);

      // Pre-generate the session id and pass it via `--session-id <uuid>`. This is the
      // interactive analogue of the headless `session-id.txt` sidechannel: the parent can't read
      // the child's stdout while the user owns the terminal (stdio-inherit), but Claude's CLI
      // accepts a harness-supplied UUID at launch, so we know the id without parsing logs.
      // Persisted to `<dirname(outputFile)>/session-id.txt` post-exit and returned on success.
      const sessionId = newSessionId();

      const inner = [
        'claude',
        ...dirFlags,
        '--model',
        shellQuote(input.model),
        '--permission-mode',
        'acceptEdits',
        '--session-id',
        shellQuote(sessionId),
        `"$(cat ${shellQuote(String(input.promptFile))})"`,
      ].join(' ');

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-claude: starting session (cwd=${String(input.cwd)})`,
        meta: { promptFile: String(input.promptFile), outputFile: String(input.outputFile), sessionId },
        at: IsoTimestamp.now(),
      });

      let child: ChildProcess;
      try {
        child = spawnFn(command, ['-lc', inner], { stdio: 'inherit', cwd: String(input.cwd) });
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

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
