import { basename } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  appendExecutionSetupRun,
  type SetupRun,
  type SetupRunOutcome,
  type SprintExecution,
} from '@src/domain/entity/sprint-execution.ts';
import { SCRIPT_TAIL_BYTES } from '@src/domain/value/script-tail-bytes.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Harness-side setup-script gate. The leaf runs unconditionally at the start of every
 * implement chain — once per affected repo — and the chain treats the result as the
 * authoritative readiness signal for the working tree. The AI session may *also* run
 * `pnpm install` (etc.) from inside its own prompt, but the harness is the source of truth:
 * if the harness setup fails, the chain hard-aborts before any task spins up.
 *
 * Why unconditional (no skip-on-stamp): a stamp from a prior run is only a historical fact,
 * not a guarantee that the dependency tree is currently coherent. `node_modules` rots when
 * lockfiles update, native modules unload after Node upgrades, `dist/` directories desync
 * across branches. The cheap belt-and-braces option is to just re-run setup every time —
 * `pnpm install` on a fully populated tree is a few hundred ms.
 *
 * Outcomes (recorded one-per-repo on `SprintExecution.setupRanAt`):
 *
 *   - `'skipped'`     — repo has no `setupScript` configured. Explicit no-op row.
 *   - `'success'`     — script ran and exited 0.
 *   - `'failed'`      — script spawned but exited non-zero. The chain aborts.
 *   - `'spawn-error'` — the shell could not start the command (missing binary, permission
 *                       denied, etc). `exitCode === -1`; the error message lands in
 *                       `stderrTailBytes`. The chain aborts.
 *
 * Each row is appended (never upserted) so the execution file carries the full history of
 * setup attempts across re-runs. The audit-stamp save is non-fatal — if persistence fails
 * after a successful script the chain still continues, with a warn log so the operator knows
 * the next resume might re-record the same row.
 *
 * Aborts surface as `Result.error(InvalidStateError)` from the use case; the chain framework
 * turns that into a failed trace entry and short-circuits the remaining elements.
 */

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
                stdoutTail: '',
                stderrTail: '',
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
              // "could not run" without parsing the message string.
              const run = makeSetupRun({
                repositoryId: repo.repositoryId,
                ranAt: deps.clock(),
                command,
                exitCode: -1,
                durationMs: 0,
                stdoutTail: '',
                stderrTail: spawnResult.error.message,
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
            // ShellScriptRunner merges stdout + stderr into a single combined buffer; the
            // existing post-task-verify leaf relies on that shape. Treat the merged tail as
            // stdout for now and leave stderr empty for non-spawn failures — the structured
            // shape is what matters; stream-splitting is a follow-up if the TUI needs it.
            const outputTail = tailBytes(output, SCRIPT_TAIL_BYTES);
            const normalisedExit = exitCode ?? -1;
            const outcome: SetupRunOutcome = passed ? 'success' : 'failed';
            const run = makeSetupRun({
              repositoryId: repo.repositoryId,
              ranAt: startedAt,
              command,
              exitCode: normalisedExit,
              durationMs,
              stdoutTail: outputTail,
              stderrTail: '',
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

            // Heuristic hint for the most common no-TTY trap: pnpm's
            // `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` happens when node_modules is out of
            // sync with the lockfile and pnpm refuses to wipe it without an interactive
            // confirmation. Detect the marker in the tail and surface an actionable hint —
            // `npm_config_confirm_modules_purge=false` does NOT cover this code path in current
            // pnpm releases, so users need to fix it on the project side.
            const pnpmTtyHint = outputTail.includes('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')
              ? 'pnpm refuses to wipe node_modules without a TTY. Either run `pnpm install` once in a terminal to resync, add `--force` to the failing pnpm command, or launch ralphctl with `CI=1`.'
              : undefined;
            deps.eventBus.publish({
              type: 'log',
              level: 'error',
              message: `setup-script ${String(repo.path)}: failed (exit=${String(exitCode ?? 'null')})`,
              at: deps.clock(),
            });
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
                // Basename so the rail's error line stays scannable; the full path lives in the
                // banner / log / execution.json audit row already.
                message: `setup-script (${basename(String(repo.path))}) exited ${String(exitCode ?? 'null')}`,
                hint:
                  pnpmTtyHint ??
                  'Inspect the setup-script tail in execution.json for the failing repo and fix the environment.',
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
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly outcome: SetupRunOutcome;
}

const makeSetupRun = (input: MakeSetupRunInput): SetupRun => ({
  repositoryId: input.repositoryId,
  ranAt: input.ranAt,
  command: input.command,
  exitCode: input.exitCode,
  durationMs: input.durationMs,
  stdoutTailBytes: input.stdoutTail,
  stderrTailBytes: input.stderrTail,
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

/** Return the last `limit` bytes of `s` (utf-8), prefixing an ellipsis marker if truncated. */
const tailBytes = (s: string, limit: number): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= limit) return s;
  // Slicing in the middle of a multi-byte char is harmless — `toString('utf8')` replaces the
  // partial bytes with the replacement char, which is visually obvious in the audit log.
  const tail = buf.subarray(buf.length - limit).toString('utf8');
  return `…[truncated ${String(buf.length - limit)} bytes]\n${tail}`;
};
