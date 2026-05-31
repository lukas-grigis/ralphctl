import { dirname } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import { type SessionMetaInput, stampSessionMetaLeaf } from '@src/application/flows/_shared/stamp-session-meta.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { roundSignalsPath } from '@src/application/flows/implement/leaves/round-artifacts.ts';

/**
 * Implement-specific wrapper around the generic {@link stampSessionMetaLeaf}. Projects the
 * `ImplementCtx` for the in-flight task + round + role onto a {@link SessionMetaInput} so the
 * generic stamp leaf can land `meta.json` at `rounds/<N>/<role>/meta.json` — sibling of the
 * provider-written `signals.json`.
 *
 * Two factories live here, one per gen-eval role, because the call sites only differ by:
 *   - the leaf name (`stamp-meta-generator-<taskId>` vs `stamp-meta-evaluator-<taskId>`)
 *   - the flow tag in meta.json (`implement-generator` vs `implement-evaluator`)
 *   - the role-specific provider / model / effort triple
 *   - escalation handling — generator-only (the evaluator is held constant across the task by
 *     design, see CLAUDE.md § Escalation), so the evaluator factory never substitutes
 *     `escalatedToModel`.
 *
 * The chain wires `resolve-round-num` directly upstream of every spawn so the
 * `currentRoundNum` / `taskWorkspaceRoot` / `currentTask` invariants are stamped before this
 * resolver runs — the throws below only fire on a wiring regression.
 */

export interface StampImplementSessionMetaDeps {
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
}

export interface StampImplementSessionMetaOpts {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
}

const resolveImplementMetaInput = (
  ctx: ImplementCtx,
  taskId: TaskId,
  role: 'generator' | 'evaluator',
  providerId: string,
  model: string,
  effort?: string
): SessionMetaInput => {
  if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
    throw new InvalidStateError({
      entity: 'chain',
      currentState: 'pre-stamp-meta',
      attemptedAction: `stamp-meta-${role}-${String(taskId)}`,
      message: `stamp-meta-${role}-${String(taskId)}: ctx.currentTask missing or mismatched`,
    });
  }
  if (ctx.taskWorkspaceRoot === undefined || ctx.currentRoundNum === undefined) {
    throw new InvalidStateError({
      entity: 'chain',
      currentState: 'pre-stamp-meta',
      attemptedAction: `stamp-meta-${role}-${String(taskId)}`,
      message: `stamp-meta-${role}-${String(taskId)}: workspace root / round num missing — resolve-round-num must run first`,
    });
  }
  const signalsPath = roundSignalsPath(ctx.taskWorkspaceRoot, ctx.currentRoundNum, role);
  const outputDir = AbsolutePath.parse(dirname(signalsPath));
  if (!outputDir.ok) throw outputDir.error;
  // Generator escalation: when `escalatedFromModel` is stamped, attribute the spawn to the
  // RESOLVED model (which is `escalatedToModel`, not the configured `model` opt). For the
  // evaluator role we leave the configured model — the evaluator is held constant across the
  // task by design (see CLAUDE.md § Escalation).
  const task = ctx.currentTask;
  const effectiveModel = role === 'generator' && task.escalatedToModel !== undefined ? task.escalatedToModel : model;
  return {
    outputDir: outputDir.value,
    flow: `implement-${role}`,
    provider: providerId,
    model: effectiveModel,
    effort: effort ?? null,
    attemptN: task.attempts.length,
    roundN: ctx.currentRoundNum,
    taskId: String(taskId),
    ...(task.escalatedFromModel !== undefined ? { escalatedFromModel: task.escalatedFromModel } : {}),
  };
};

export const stampImplementGeneratorSessionMetaLeaf = (
  deps: StampImplementSessionMetaDeps,
  opts: StampImplementSessionMetaOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  stampSessionMetaLeaf<ImplementCtx>(
    { writeFile: deps.writeFile, clock: deps.clock },
    {
      name: `stamp-meta-generator-${String(taskId)}`,
      resolve: (ctx) => resolveImplementMetaInput(ctx, taskId, 'generator', opts.providerId, opts.model, opts.effort),
    }
  );

export const stampImplementEvaluatorSessionMetaLeaf = (
  deps: StampImplementSessionMetaDeps,
  opts: StampImplementSessionMetaOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  stampSessionMetaLeaf<ImplementCtx>(
    { writeFile: deps.writeFile, clock: deps.clock },
    {
      name: `stamp-meta-evaluator-${String(taskId)}`,
      resolve: (ctx) => resolveImplementMetaInput(ctx, taskId, 'evaluator', opts.providerId, opts.model, opts.effort),
    }
  );
