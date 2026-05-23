import { basename, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  appendExecutionSetupRun,
  type SetupRun,
  type SetupRunOutcome,
  type SprintExecution,
} from '@src/domain/entity/sprint-execution.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/** Per-line cap for setup-script tail rows surfaced to the TUI. JS code units; see comment
 *  on the call site for why graphemes are overkill for ralphctl's actual content. */
const BANNER_LINE_MAX = 200;
/** Number of recent non-blank lines kept on the bus when a setup-script fails. */
const MAX_TAIL_LINES = 20;
/** Display-clip marker (audit-[03]). Mirrors `glyphs.clipEllipsis` in TUI tokens — duplicated
 *  here because the chains layer cannot import from UI (ESLint fence). One char, U+2026. */
const CLIP_ELLIPSIS = '…';

/**
 * Harness-side setup-script gate. The leaf runs at the start of every implement chain —
 * once per affected repo — and the chain treats the result as the authoritative readiness
 * signal for the working tree. The AI session may *also* run `pnpm install` (etc.) from
 * inside its own prompt, but the harness is the source of truth: if the harness setup
 * fails, the chain hard-aborts before any task spins up.
 *
 * **New-sprint vs resume gate** (audit [04]): setup runs once per repo per sprint. The
 * gate uses `SprintExecution.setupRanAt` as the audit source. For each repo:
 *
 *   - If a prior entry exists with `outcome === 'success'` AND `command === current
 *     setupScript` → skip this repo (resume path). Log "skipped on resume" at info tier.
 *   - Otherwise → run the script (new path / failure-retry / command-drift retry).
 *
 * Rationale: setup is idempotent but slow; running `pnpm install` / `mvn dependency:go-offline`
 * on every implement resume burns 10-60s per repo for no gain. The first successful run
 * proves the tree builds; subsequent resumes trust that state.
 *
 * Command drift is treated as a new run: if the operator changes `project.json#setupScript`
 * between runs, the prior success is stale and the new command must be validated.
 *
 * Outcomes (recorded one-per-repo on `SprintExecution.setupRanAt` when the script runs):
 *
 *   - `'skipped'`     — repo has no `setupScript` configured. Explicit no-op row.
 *   - `'success'`     — script ran and exited 0.
 *   - `'failed'`      — script spawned but exited non-zero. The chain aborts.
 *   - `'spawn-error'` — the shell could not start the command (missing binary, permission
 *                       denied, etc). `exitCode === -1`. The spawn error message lands on
 *                       the abort log / banner but is no longer persisted on the audit row
 *                       (Wave 8 / audit-[06]). The chain aborts.
 *
 * The resume-path skip does NOT append a new audit row; the prior success entry stays
 * canonical. Each fresh run appends one row.
 *
 * Aborts surface as `Result.error(InvalidStateError)` from the use case; the chain framework
 * turns that into a failed trace entry and short-circuits the remaining elements.
 */

/**
 * Marker emitted by pnpm 11's `removeModulesDirSafe` when it wants to wipe `node_modules`
 * but can't prompt for confirmation. Tracked separately so the dependency on pnpm's error
 * shape is explicit — when pnpm renames or restructures the error, only this constant moves.
 * See pnpm/pnpm#9966 for the breaking-change context.
 */
const PNPM_NO_TTY_ERROR_MARKER = 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY';

export interface SetupScriptRunnerLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly sprintExecutionRepo: Save<SprintExecution>;
  readonly logger: Logger;
}

export interface SetupRepoEntry {
  readonly repositoryId: RepositoryId;
  readonly path: AbsolutePath;
  readonly setupScript?: string;
}

export interface SetupScriptRunnerLeafOpts {
  /** Every repo on the project. The leaf iterates this list, not the task-touched subset. */
  readonly repos: readonly SetupRepoEntry[];
  readonly timeoutMs?: number;
  /**
   * Per-sprint state directory. When set, the leaf writes the full untruncated setup-script
   * output to `<sprintDir>/logs/setup/<repo-id>.log` per audit [01] / [03]. The audit row
   * itself carries structured metadata only — operators read the full body from the log
   * file or via the `LogTailReader` port for lazy display. Absent → no file written (test
   * paths that don't care about disk logs still work).
   */
  readonly sprintDir?: AbsolutePath;
}

interface LeafInput {
  readonly execution: SprintExecution;
}

interface LeafOutput {
  readonly execution: SprintExecution;
}

export const setupScriptRunnerLeaf = (
  deps: SetupScriptRunnerLeafDeps,
  opts: SetupScriptRunnerLeafOpts
): Element<ImplementCtx> => {
  // Friendly rail label. Single-repo runs render as `setup-script · <repo>`; multi-repo runs
  // keep it generic (`setup-script`) so the row doesn't lie about which repo is in flight —
  // per-row attribution lives in the chain log and the BaselineHealthCard.
  const repoLabel =
    opts.repos.length === 1 && opts.repos[0] !== undefined ? ` · ${basename(String(opts.repos[0].path))}` : '';
  return leaf<ImplementCtx, LeafInput, LeafOutput>(
    'setup-script-runner',
    {
      useCase: {
        execute: async (input): Promise<Result<LeafOutput, DomainError>> => {
          let execution = input.execution;
          for (const repo of opts.repos) {
            const command = repo.setupScript?.trim() ?? '';
            // Resume gate: if a prior chain on this sprint already ran setup successfully
            // for this repo under the *same* command, skip. The previous success entry
            // remains canonical; no new row is appended. Command drift (operator edited
            // `project.json#setupScript`) breaks the gate and re-runs the script.
            if (command.length > 0) {
              const priorSuccess = execution.setupRanAt.find(
                (r) => String(r.repositoryId) === String(repo.repositoryId) && r.outcome === 'success'
              );
              if (priorSuccess && priorSuccess.command === command) {
                deps.eventBus.publish({
                  type: 'log',
                  level: 'info',
                  message: `setup-script ${String(repo.path)}: skipped on resume (succeeded earlier on this sprint)`,
                  at: deps.clock(),
                });
                continue;
              }
              if (priorSuccess && priorSuccess.command !== command) {
                deps.eventBus.publish({
                  type: 'log',
                  level: 'info',
                  message: `setup-script ${String(repo.path)}: re-running — configured command changed since prior success (was: ${priorSuccess.command}, now: ${command})`,
                  at: deps.clock(),
                });
              }
            }
            if (command.length === 0) {
              // No script configured is NOT a failure — the chain continues. But it is also not
              // a silent pass: the operator deserves to know that *nothing was validated* before
              // the AI starts touching the tree. Surface as a warn-tier banner (dismissible) and
              // a warn-level log row so it lands in both the Recent-log tail and the persistent
              // chain.log. Banner id is repo-keyed so re-runs replace rather than stack.
              const run = makeSetupRun({
                repositoryId: repo.repositoryId,
                ranAt: deps.clock(),
                command: '',
                exitCode: 0,
                durationMs: 0,
                outcome: 'skipped',
              });
              execution = await persistRun(execution, run, deps);
              deps.eventBus.publish({
                type: 'log',
                level: 'warn',
                message: `setup-script ${String(repo.path)}: skipped — no script configured (nothing was validated)`,
                at: deps.clock(),
              });
              deps.eventBus.publish({
                type: 'banner-show',
                id: `setup-script-skipped-${String(repo.repositoryId)}`,
                tier: 'warn',
                message: `No setup script configured for ${String(repo.path)} — nothing was validated before implement`,
                cause: 'configure one via `project` settings to gate the working tree',
                at: deps.clock(),
              });
              continue;
            }

            const startedAt = deps.clock();
            const spawnResult = await deps.shellScriptRunner.run(repo.path, command, {
              ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
              env: { RALPHCTL_LIFECYCLE_EVENT: 'setup' },
            });

            if (!spawnResult.ok) {
              // Spawn-time failure: the shell could not start the command at all (ENOENT, etc).
              // Recorded with `exitCode: -1` so consumers can distinguish "ran and failed" from
              // "could not run" without parsing the message string. The spawn error message is
              // surfaced on the abort log + banner cause (no longer persisted on the row).
              const run = makeSetupRun({
                repositoryId: repo.repositoryId,
                ranAt: deps.clock(),
                command,
                exitCode: -1,
                durationMs: 0,
                outcome: 'spawn-error',
              });
              await persistRun(execution, run, deps);
              deps.eventBus.publish({
                type: 'log',
                level: 'error',
                message: `setup-script ${String(repo.path)}: spawn-error — ${spawnResult.error.message}`,
                at: deps.clock(),
              });
              deps.eventBus.publish({
                type: 'banner-show',
                id: `setup-script-${String(repo.repositoryId)}`,
                tier: 'error',
                message: `Setup script failed for ${String(repo.path)}: ${command}`,
                cause: `spawn-error — ${spawnResult.error.message}`,
                at: deps.clock(),
              });
              return Result.error(
                new InvalidStateError({
                  entity: 'sprint',
                  currentState: 'pre-implement',
                  attemptedAction: 'setup-script',
                  message: `setup-script (${basename(String(repo.path))}) could not spawn: ${spawnResult.error.message}`,
                  hint: 'Ensure the setup command is on PATH and is executable from the repo root.',
                })
              );
            }

            const { passed, exitCode, output, durationMs } = spawnResult.value;

            // Audit [01] / [03]: persist the full untruncated output to `<sprintDir>/logs/setup/`
            // so the operator can grep / tail the real failure. Best-effort — a write failure
            // logs warn and never aborts the chain (the audit row remains canonical).
            if (opts.sprintDir !== undefined) {
              const logPath = join(String(opts.sprintDir), 'logs', 'setup', `${String(repo.repositoryId)}.log`);
              const wrote = await writeTextAtomic(logPath, output);
              if (!wrote.ok) {
                deps.eventBus.publish({
                  type: 'log',
                  level: 'warn',
                  message: `setup-script ${String(repo.path)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
                  at: deps.clock(),
                });
              }
            }
            const normalisedExit = exitCode ?? -1;
            const outcome: SetupRunOutcome = passed ? 'success' : 'failed';
            const run = makeSetupRun({
              repositoryId: repo.repositoryId,
              ranAt: startedAt,
              command,
              exitCode: normalisedExit,
              durationMs,
              outcome,
            });
            execution = await persistRun(execution, run, deps);

            if (passed) {
              deps.eventBus.publish({
                type: 'log',
                level: 'info',
                message: `setup-script ${String(repo.path)}: success (exit=0, ${String(durationMs)}ms)`,
                at: deps.clock(),
              });
              continue;
            }

            // pnpm 11 hardened `removeModulesDirSafe` to abort on missing TTY rather than
            // silently re-creating `node_modules` (pnpm/pnpm#9966). When the marker fires we
            // surface an actionable project-side hint — `npm_config_confirm_modules_purge=false`
            // (the env shim in shell-script-runner.ts) does NOT cover this code path, so the
            // operator has to fix it at the project level. We deliberately do NOT auto-retry
            // with `CI=true`: that flag flips Maven Surefire, Spring Boot
            // `@DisabledIfEnvironmentVariable("CI")` gates, pnpm's frozen-lockfile semantics,
            // and assorted other toolchain heuristics, so a "green" retry could mask drift from
            // the real baseline the post-task verify gate later runs without `CI=true`.
            const noTtyDetected = output.includes(PNPM_NO_TTY_ERROR_MARKER);
            const pnpmTtyHint = noTtyDetected
              ? 'pnpm no-TTY abort detected. Fix project-side: pin pnpm < 11 in mise.toml / package.json#packageManager (pnpm/pnpm#9966), run `pnpm install` once in a terminal to resync, or add `confirm-modules-purge=false` to .npmrc.'
              : undefined;
            deps.eventBus.publish({
              type: 'log',
              level: 'error',
              message: `setup-script ${String(repo.path)}: failed (exit=${String(exitCode ?? 'null')})`,
              at: deps.clock(),
            });
            // Surface the last few lines of script output as error-level logs so the TUI's
            // Recent-log tail renders the actionable bit alongside the headline. The full
            // output already landed verbatim at `<sprintDir>/logs/setup/<repo-id>.log` (above);
            // these bus events are a *display* surface, so per-line + per-count clipping is
            // valid here (audit-[03]: clip at display, never at persistence). Headline first,
            // detail rows after.
            //
            // Clip unit: JS string `.length` (UTF-16 code units) at the per-line cap. ralphctl's
            // setup output is shell stdout — overwhelmingly ASCII (paths, exit codes, npm/pnpm
            // diagnostic strings); grapheme-aware clipping via Intl.Segmenter would be
            // overkill for the actual content. A pathological emoji-in-script string could be
            // split mid-surrogate, in which case Ink renders the broken pair as a replacement
            // glyph — still visually obvious that the line was clipped. If/when we surface
            // user-authored prose through this path, switch to Intl.Segmenter and update the
            // banner-clip unit test fixtures.
            const tailLines = output
              .split('\n')
              .map((l) => l.trimEnd())
              .filter((l) => l.length > 0)
              .slice(-MAX_TAIL_LINES);
            const totalCount = output.split('\n').filter((l) => l.trim().length > 0).length;
            const elided = Math.max(0, totalCount - tailLines.length);
            const repoBasename = basename(String(repo.path));
            if (elided > 0) {
              // Multi-line collapse marker: signals to the operator that earlier lines were
              // dropped from this surface (the full log is on disk).
              deps.eventBus.publish({
                type: 'log',
                level: 'error',
                message: `setup-script (${repoBasename}): ${CLIP_ELLIPSIS} ${String(elided)} earlier line${elided === 1 ? '' : 's'} elided — full log at logs/setup/${String(repo.repositoryId)}.log`,
                at: deps.clock(),
              });
            }
            for (const line of tailLines) {
              const clipped =
                line.length > BANNER_LINE_MAX ? `${line.slice(0, BANNER_LINE_MAX - 1)}${CLIP_ELLIPSIS}` : line;
              deps.eventBus.publish({
                type: 'log',
                level: 'error',
                message: `setup-script (${repoBasename}): ${clipped}`,
                at: deps.clock(),
              });
            }
            deps.eventBus.publish({
              type: 'banner-show',
              id: `setup-script-${String(repo.repositoryId)}`,
              tier: 'error',
              message: `Setup script failed for ${String(repo.path)}: ${command}`,
              cause:
                pnpmTtyHint !== undefined
                  ? `exit ${String(exitCode ?? 'null')} — ${pnpmTtyHint}`
                  : `exit ${String(exitCode ?? 'null')}`,
              at: deps.clock(),
            });
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'pre-implement',
                attemptedAction: 'setup-script',
                // The rail row already prefixes `setup-script · <repo>`; the message stays
                // minimal so the operator's eye is not retracing the same name. The full
                // command + path are in the banner / log / execution.json audit row.
                message:
                  pnpmTtyHint !== undefined
                    ? `exited ${String(exitCode ?? 'null')} (no-tty pnpm)`
                    : `exited ${String(exitCode ?? 'null')}`,
                hint:
                  pnpmTtyHint ??
                  'Inspect <sprintDir>/logs/setup/<repo-id>.log for the failing repo and fix the environment.',
              })
            );
          }
          return Result.ok({ execution });
        },
      },
      input: (ctx) => {
        if (ctx.execution === undefined) {
          throw new InvalidStateError({
            entity: 'chain',
            currentState: 'pre-setup-script',
            attemptedAction: 'setup-script-runner',
            message: 'setup-script-runner: ctx.execution is undefined — load-sprint-execution must run first',
          });
        }
        return { execution: ctx.execution };
      },
      // Re-stamp ctx with the (possibly mutated) execution so downstream leaves like
      // `resolveBranchLeaf` see the audit-appended value.
      output: (ctx, out) => ({ ...ctx, execution: out.execution }),
    },
    { label: `setup-script${repoLabel}` }
  );
};

interface MakeSetupRunInput {
  readonly repositoryId: RepositoryId;
  readonly ranAt: IsoTimestamp;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outcome: SetupRunOutcome;
}

const makeSetupRun = (input: MakeSetupRunInput): SetupRun => ({
  repositoryId: input.repositoryId,
  ranAt: input.ranAt,
  command: input.command,
  exitCode: input.exitCode,
  durationMs: input.durationMs,
  outcome: input.outcome,
});

/**
 * Append the row and persist. A persistence failure is logged but never aborts the chain —
 * the script outcome (which is what we actually wanted to verify) has already happened, and
 * losing the audit stamp at most causes a duplicate row on the next resume.
 */
const persistRun = async (
  execution: SprintExecution,
  run: SetupRun,
  deps: SetupScriptRunnerLeafDeps
): Promise<SprintExecution> => {
  const next = appendExecutionSetupRun(execution, run);
  const saved = await deps.sprintExecutionRepo.save(next);
  if (!saved.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `setup-script audit persist failed for repo ${String(run.repositoryId)} — ${saved.error.message}`,
      at: deps.clock(),
    });
  }
  return next;
};
