import { promises as fs } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';

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

/** Test seam — same shape as `node:child_process.spawn` with `stdio: 'inherit'`. */
export type InteractiveSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'inherit'; readonly cwd: string }
) => ChildProcess;

export interface InteractiveCopilotDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the binary name for tests / packaging. Defaults to `'copilot'`. */
  readonly command?: string;
  /** Test seam for prompt-file reads. Defaults to `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<string>;
}

const defaultSpawn: InteractiveSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { stdio: options.stdio, cwd: options.cwd });

const defaultReadFile = (path: string): Promise<string> => fs.readFile(path, 'utf8');

export const createInteractiveCopilotProvider = (deps: InteractiveCopilotDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'copilot';
  const readFile = deps.readFile ?? defaultReadFile;

  return {
    async run(input: InteractiveAiProviderInput) {
      if (!isCopilotModel(input.model)) {
        return Result.error(
          new InvalidStateError({
            entity: 'interactive-copilot',
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

      const args = [...dirFlags, `--model=${input.model}`, '--allow-all-tools', '-i', prompt];

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-copilot: starting session (cwd=${String(input.cwd)})`,
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
            message: `interactive-copilot: failed to spawn — ${stringifyError(cause)}`,
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
        message: `interactive-copilot: session exited (code=${String(exitCode ?? 'null')})`,
        at: IsoTimestamp.now(),
      });

      // TODO(sessionId): see claude/interactive.ts for the rationale — stdio-inherit means the
      // parent can't read stdout while the user owns the terminal. Copilot doesn't expose a
      // per-session logfile, so capture here needs PTY-mirroring. Per requirements REQ-3,
      // absence is non-fatal.
      if (exitCode === 0) return Result.ok({});
      return Result.error(
        new InvalidStateError({
          entity: 'interactive-copilot',
          currentState: 'session-exit',
          attemptedAction: 'run',
          message: `interactive-copilot: session exited with code ${String(exitCode ?? 'null')}`,
        })
      );
    },
  };
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
