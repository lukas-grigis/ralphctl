import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchCloseSprint = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, bridge, sessionId } = ctx;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // Pre-flow HITL: closing a sprint is terminal — a stray `n → close-sprint → Enter` would
  // otherwise flip a sprint to `done` by accident. Cancel aborts the launch entirely.
  const message = `Close sprint "${snapshot.sprint.name}"? It moves to done and stops accepting new work.`;
  const confirmed = await deps.interactive.askConfirm({ message });
  if (!confirmed.ok || confirmed.value !== true) {
    return { ok: false, reason: 'Cancelled.' };
  }
  const progressPath = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'progress.md')
  );
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };
  const element: Element<CloseSprintCtx> = createCloseSprintFlow({
    sprintRepo: deps.app.sprintRepo,
    clock: deps.app.clock,
    logger: deps.app.logger,
    appendFile: deps.app.appendFile,
    progressFile: progressPath.value,
  });
  const runner = createRunner<CloseSprintCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Close sprint — ${snapshot.sprint.name}`,
  };
};
