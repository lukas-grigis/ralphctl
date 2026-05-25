import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Per-round / per-role AI attribution sidecar stamped at
 * `<workspaceRoot>/rounds/<N>/<role>/role-meta.json` BEFORE the corresponding gen-eval spawn.
 *
 * Co-exists with the generic `_shared/stamp-session-meta` leaf (which writes `meta.json`
 * beside `signals.json` across every AI flow). The role-meta sidecar is implement-only and
 * carries the implement-specific attempt / escalation context the generic shape does not —
 * `role`, `attemptN`, and `escalatedFromModel` are first-class fields here, making per-task
 * post-mortems possible without joining against `tasks.json`.
 *
 * Why before the spawn: `settings.ai.implement.{generator,evaluator}.{provider,model,effort}`
 * is only persisted in `settings.json`, which mutates. Once a user edits settings between
 * runs, historical attribution is lost. Writing the sidecar BEFORE the spawn captures
 * attribution even when the spawn itself crashes (signals-missing / process exit / OOM).
 *
 * Round numbering is owned by `resolveRoundNumLeaf` (runs first in the gen-eval iteration);
 * both stamp leaves read `ctx.currentRoundNum` — no in-leaf disk reads, no races between
 * sibling stamps and spawns.
 *
 * `escalatedFromModel` is mirrored from {@link Task} when present — the chain's escalation
 * policy stamps it on the task on first plateau, so a later round on an escalated generator
 * can be attributed to the upgrade rather than guessed at from the configured model.
 *
 * Forward-only: no historical sprint dirs are back-filled.
 */

export interface StampRoleMetaDeps {
  /** Atomic file writer (tmp+rename) — directly threaded from `ImplementDeps.writeFile`. */
  readonly writeFile: WriteFile;
  /** Wall-clock seed; `IsoTimestamp.now()` in production, fixed in tests. */
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface StampRoleMetaOpts {
  /**
   * Resolved provider id — exactly the string under `settings.ai.implement.<role>.provider`.
   * Threaded from the launcher per role so a cross-provider configuration records the right
   * adapter on each spawn.
   */
  readonly provider: string;
  /**
   * Resolved model id. For the generator role the on-disk attribution still reflects the
   * configured model — the per-round runtime override (escalated-to model on
   * `Task.escalatedToModel`) is captured separately via the `escalatedFromModel` field,
   * which together with the configured `model` reconstructs both halves of the upgrade
   * decision without requiring a join across `tasks.json`.
   */
  readonly model: string;
  /**
   * Resolved effort level (after `resolveEffortForRow` ran in the launcher), or `undefined`
   * when the row has no effort and the provider falls back to its CLI default. Persisted as
   * `null` in `role-meta.json` — JSON has no `undefined`, and a missing key would be
   * ambiguous with "field never written".
   */
  readonly effort?: string;
}

/**
 * Persisted shape of `rounds/<N>/<role>/role-meta.json`. Co-located with the leaf — this is
 * harness-written metadata (not AI output), so a zod schema would be over-engineering. Kept
 * intentionally minimal: `endedAt` and per-tool-versioning are deferred to a follow-up.
 */
interface RoleMeta {
  readonly role: 'generator' | 'evaluator';
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly attemptN: number;
  readonly roundN: number;
  readonly startedAt: string;
  readonly escalatedFromModel: string | null;
}

const renderBody = (
  role: 'generator' | 'evaluator',
  opts: StampRoleMetaOpts,
  body: Omit<RoleMeta, 'role' | 'provider' | 'model' | 'effort'>
): string => {
  const meta: RoleMeta = {
    role,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort ?? null,
    ...body,
  };
  // Stable 2-space-indented JSON so a `git diff` between sprint dirs is reviewable, and
  // trailing newline (POSIX text-file convention).
  return `${JSON.stringify(meta, null, 2)}\n`;
};

interface StampRoleMetaInput {
  readonly workspaceRoot: AbsolutePath;
  readonly roundN: number;
  readonly attemptN: number;
  readonly escalatedFromModel?: string;
}

const buildStampLeaf = (
  role: 'generator' | 'evaluator',
  deps: StampRoleMetaDeps,
  opts: StampRoleMetaOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const name = `stamp-role-meta-${role}-${String(taskId)}`;
  return leaf<ImplementCtx, StampRoleMetaInput, void>(name, {
    useCase: {
      async execute(input) {
        const dir = join(String(input.workspaceRoot), 'rounds', String(input.roundN), role);
        const pathRes = AbsolutePath.parse(join(dir, 'role-meta.json'));
        if (!pathRes.ok) return Result.error(pathRes.error);

        const content = renderBody(role, opts, {
          attemptN: input.attemptN,
          roundN: input.roundN,
          startedAt: String(deps.clock()),
          escalatedFromModel: input.escalatedFromModel ?? null,
        });
        const wrote = await deps.writeFile(pathRes.value, content);
        if (!wrote.ok) {
          // The write port creates parent directories atomically — failure here is a real
          // disk / permission issue. Surface to the chain rather than swallowing: missing
          // attribution on a working spawn would be misleading. Audit trail must be either
          // complete or absent.
          return Result.error(wrote.error);
        }
        deps.logger.named('implement.role-meta').debug('stamped role meta', {
          taskId,
          role,
          provider: opts.provider,
          model: opts.model,
          roundN: input.roundN,
          attemptN: input.attemptN,
        });
        return Result.ok(undefined);
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: `pre-stamp-role-meta-${role}`,
          attemptedAction: name,
          message: `${name}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: `pre-stamp-role-meta-${role}`,
          attemptedAction: name,
          message: `${name}: ctx.taskWorkspaceRoot missing — buildTaskWorkspaceLeaf must run first`,
        });
      }
      if (ctx.currentRoundNum === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: `pre-stamp-role-meta-${role}`,
          attemptedAction: name,
          message: `${name}: ctx.currentRoundNum missing — resolve-round-num must run first`,
        });
      }
      // `attemptN` matches the generator/evaluator leaves: `task.attempts.length` after
      // `start-attempt` opened the running attempt. The running attempt is included in the
      // length, so this counts the n-th attempt-within-task (1-indexed, parallels
      // `task.maxAttempts`).
      const attemptN = ctx.currentTask.attempts.length;
      const escalatedFromModel = ctx.currentTask.escalatedFromModel;
      return {
        workspaceRoot: ctx.taskWorkspaceRoot,
        roundN: ctx.currentRoundNum,
        attemptN,
        ...(escalatedFromModel !== undefined ? { escalatedFromModel } : {}),
      };
    },
    output: (ctx) => ctx,
  });
};

/**
 * Generator-pass role-meta stamp. Reads `ctx.currentRoundNum` (set by `resolveRoundNumLeaf`)
 * and writes `rounds/<N>/generator/role-meta.json` before the generator spawn.
 */
export const stampGeneratorRoleMetaLeaf = (
  deps: StampRoleMetaDeps,
  opts: StampRoleMetaOpts,
  taskId: TaskId
): Element<ImplementCtx> => buildStampLeaf('generator', deps, opts, taskId);

/**
 * Evaluator-pass role-meta stamp. Reads `ctx.currentRoundNum` (set by `resolveRoundNumLeaf`)
 * and writes `rounds/<N>/evaluator/role-meta.json` before the evaluator spawn.
 */
export const stampEvaluatorRoleMetaLeaf = (
  deps: StampRoleMetaDeps,
  opts: StampRoleMetaOpts,
  taskId: TaskId
): Element<ImplementCtx> => buildStampLeaf('evaluator', deps, opts, taskId);
