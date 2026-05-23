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
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';

/**
 * Interactive `codex` adapter. Spawns the Codex CLI with `stdio: 'inherit'` so the user sees
 * the TUI directly and can chat. Mirrors the Claude interactive adapter — the harness has no
 * read-side on stdout while the user owns the terminal, so we tell Codex (via the prompt
 * body) to write its final answer to {@link InteractiveAiProviderInput.outputFile}, and the
 * caller reads that file back after this session resolves.
 *
 * Codex's top-level (non-`exec`) command starts the TUI and accepts an optional positional
 * prompt — `codex "explain this codebase"`. We inline `"$(cat <promptFile>)"` via `bash -lc`
 * so very large prompt files don't hit argv length limits. `-s workspace-write -a never`
 * matches Claude's `--permission-mode acceptEdits` intent: file writes inside the workspace
 * run without a confirmation step (so the AI can drop its answer in `outputFile`).
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

/** Test seam — same shape as `node:child_process.spawn` with `stdio: 'inherit'`. */
export type InteractiveSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'inherit'; readonly cwd: string }
) => ChildProcess;

export interface InteractiveCodexDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the shell name for tests / packaging. Defaults to `'bash'`. */
  readonly command?: string;
}

const defaultSpawn: InteractiveSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { stdio: options.stdio, cwd: options.cwd });

export const createInteractiveCodexProvider = (deps: InteractiveCodexDeps): InteractiveAiProvider => {
  const spawnFn: InteractiveSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'bash';

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
        .flatMap((p) => ['--add-dir', shellQuote(p)]);

      const inner = [
        'codex',
        '--cd',
        shellQuote(String(input.cwd)),
        ...dirFlags,
        '--model',
        shellQuote(input.model),
        '-s',
        'workspace-write',
        '-a',
        'never',
        `"$(cat ${shellQuote(String(input.promptFile))})"`,
      ].join(' ');

      deps.eventBus.publish({
        type: 'log',
        level: 'info',
        message: `interactive-codex: starting session (cwd=${String(input.cwd)})`,
        meta: { promptFile: String(input.promptFile), outputFile: String(input.outputFile) },
        at: IsoTimestamp.now(),
      });

      let child: ChildProcess;
      try {
        child = spawnFn(command, ['-lc', inner], { stdio: 'inherit', cwd: String(input.cwd) });
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

      // TODO(sessionId): see claude/interactive.ts for the rationale — stdio-inherit means the
      // parent can't read stdout while the user owns the terminal, so the optional `sessionId`
      // result field stays empty until a PTY-mirror or ~/.codex/sessions/ logfile probe lands.
      // Per requirements REQ-3, absence is non-fatal.
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

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
