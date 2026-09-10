import { join } from 'node:path';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import { closeSprintManifest } from '@src/application/flows/close-sprint/manifest.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { resolveDistillComposition } from '@src/application/ui/shared/launch/distill.ts';

export const launchCloseSprint = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, bridge, sessionId } = ctx;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // Pre-flow HITL: closing a sprint is terminal — a stray `n → close-sprint → Enter` would
  // otherwise flip a sprint to `done` by accident. Cancel aborts the launch entirely. `snapshot`
  // already holds the current sprint's tasks, so the count of blocked / todo work is folded into
  // the same confirm rather than a separate round-trip — the in-chain `confirm-blocked-tasks`
  // gate below is the one that names blocked tasks individually and can still turn back a
  // confirmed-here-but-reconsidered close.
  //
  // The blocked-task threshold + its explanatory hint are read off the flow's own manifest
  // (`closeSprintManifest.triggers.maxBlockedTasks` / `maxBlockedTasksHint`) rather than
  // hardcoded here — the manifest declares the threshold once, declaratively, instead of every
  // launcher re-deriving it inline. `maxBlockedTasks` defaults to 0 (any blocked task at all),
  // matching this flow's confirm-and-proceed decision.
  const { maxBlockedTasks = 0, maxBlockedTasksHint } = closeSprintManifest.triggers;
  const blockedTaskCount = snapshot.tasks.filter((t) => t.status === 'blocked').length;
  const todoTaskCount = snapshot.tasks.filter((t) => t.status === 'todo').length;
  const exceedsBlockedThreshold = blockedTaskCount > maxBlockedTasks;
  const unfinishedParts = [
    ...(exceedsBlockedThreshold ? [`${String(blockedTaskCount)} blocked`] : []),
    ...(todoTaskCount > 0 ? [`${String(todoTaskCount)} todo`] : []),
  ];
  const unfinishedNote =
    unfinishedParts.length > 0 ? ` ${unfinishedParts.join(' and ')} task(s) remain unfinished.` : '';
  const blockedHintNote = exceedsBlockedThreshold && maxBlockedTasksHint !== undefined ? ` ${maxBlockedTasksHint}` : '';
  const message = `Close sprint "${snapshot.sprint.name}"? It moves to done and stops accepting new work.${unfinishedNote}${blockedHintNote}`;
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

  // Direct-build the canonical `<id>--<slug>/` sprint dir from the loaded sprint entity.
  const sprintDir = buildSprintDir(deps.storage.dataRoot, snapshot.sprint.id, snapshot.sprint.slug);
  const progressPath = AbsolutePath.parse(join(sprintDir, 'progress.md'));
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };

  const distill = resolveDistillComposition(ctx, sprintDir);
  // Always-on durable narrative-tier refresh: regenerate `learnings.md` from the per-project ledger
  // at close, even when the operator declines the heavyweight distill. Available whenever a project
  // is loaded (its id selects the per-project ledger dir).
  const memoryMirror =
    snapshot.project !== undefined
      ? {
          writeFile: deps.app.writeFile,
          memoryRoot: deps.storage.memoryRoot,
          projectId: String(snapshot.project.id),
        }
      : undefined;
  const element: Element<CloseSprintCtx> = createCloseSprintFlow({
    sprintRepo: deps.app.sprintRepo,
    clock: deps.app.clock,
    logger: deps.app.logger,
    appendFile: deps.app.appendFile,
    progressFile: progressPath.value,
    ...(memoryMirror !== undefined ? { memoryMirror } : {}),
    ...(distill !== undefined ? { distill } : {}),
    // The TUI always has an `InteractivePrompt` — wire the in-chain blocked-task gate so a
    // blocked task is named and confirmed even if the pre-flight summary above was skimmed.
    blockedTasksGate: { taskRepo: deps.app.taskRepo, interactive: deps.interactive },
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
