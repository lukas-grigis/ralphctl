import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { resolveDistillComposition } from '@src/application/ui/shared/launch/distill.ts';

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
  // Second HITL, opt-in and defaulting NO: promoting learnings rewrites the project's native
  // context files (CLAUDE.md / AGENTS.md / …) — never auto-accept. The `[y/N]` copy signals the
  // default. A non-ok result is a cancellation (Ctrl+C / Esc → `AbortError`, `.ok === false`) —
  // cancel the whole launch, symmetric with the first close confirm above. Only a deliberate
  // `false` proceeds without distilling (the in-chain `distill-gate` guard then skips the body).
  const distillConfirm = await deps.interactive.askConfirm({
    message: "Distill this sprint's learnings into project context files? [y/N]",
  });
  if (!distillConfirm.ok) return { ok: false, reason: 'Cancelled.' };
  const distillRequested = distillConfirm.value === true;

  const sprintDir = join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id));
  const progressPath = AbsolutePath.parse(join(sprintDir, 'progress.md'));
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };

  const distill = resolveDistillComposition(ctx, sprintDir);
  const element: Element<CloseSprintCtx> = createCloseSprintFlow({
    sprintRepo: deps.app.sprintRepo,
    clock: deps.app.clock,
    logger: deps.app.logger,
    appendFile: deps.app.appendFile,
    progressFile: progressPath.value,
    ...(distill !== undefined ? { distill } : {}),
  });
  const runner = createRunner<CloseSprintCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id, distillRequested },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Close sprint — ${snapshot.sprint.name}`,
  };
};
