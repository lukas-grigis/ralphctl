/**
 * FeedbackPromptLoop — post-execute feedback loop + auto-close logic.
 *
 * When an `execute` session settles successfully, this component fires an
 * async IIFE that:
 *   1. Prompts the user for free-form feedback (editor prompt).
 *   2. On non-empty submission: launches a `feedback` chain session, waits
 *      for it to settle, then loops.
 *   3. On empty submission or cancel: exits the loop and attempts auto-close
 *      (closes the sprint when all tasks are `done` and sprint is `active`).
 *
 * The loop lives in a `useEffect` so it fires exactly once per settled
 * execute session (guarded by `feedbackPromptedFor` ref).
 *
 * Props carry the full runtime context needed for the async operations so
 * the parent execute-view stays as the orchestrator and this component owns
 * only its specific side-effect.
 */

import { useEffect, useRef } from 'react';
import { getPrompt, getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import { createFeedbackFlow, type FeedbackCtx } from '@src/application/chains/feedback/feedback-flow.ts';
import { CloseSprintUseCase } from '@src/business/usecases/sprint/close-sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { SessionManagerPort, SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import { getExecuteCtxFields } from './ctx-helpers.ts';

interface FeedbackPromptLoopProps {
  readonly descriptor: SessionDescriptor | null;
  readonly sessionManager: SessionManagerPort | null;
  /** Live runner status — overrides the frozen descriptor.status for terminal detection. */
  readonly runnerStatus: 'completed' | 'failed' | 'aborted' | null;
}

function isExecuteSession(label: string): boolean {
  return label.startsWith('execute ');
}

export function FeedbackPromptLoop({ descriptor, sessionManager, runnerStatus }: FeedbackPromptLoopProps): null {
  const feedbackPromptedFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!sessionManager || !descriptor) return;

    // Use runnerStatus (live) rather than descriptor.status (frozen snapshot).
    const completedStatus = runnerStatus ?? descriptor.status;
    if (completedStatus !== 'completed') return;
    if (!isExecuteSession(descriptor.label)) return;
    if (feedbackPromptedFor.current.has(descriptor.id)) return;
    feedbackPromptedFor.current.add(descriptor.id);

    const fields = getExecuteCtxFields(descriptor.runner.ctx);
    if (!fields) return;
    const { sprintId, cwd } = fields;

    void (async () => {
      const prompt = await getPrompt();
      const deps = await getSharedDeps();
      let iter = 0;
      // Empty submission terminates the loop; there is no iteration cap.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        iter += 1;
        let text: string | null;
        try {
          text = await prompt.editor({
            message: `Provide feedback for the AI to apply (round ${String(iter)}) — empty submit to finish · Ctrl+D submit · Esc cancel`,
          });
        } catch (err) {
          if (err instanceof PromptCancelledError) break;
          throw err;
        }
        if (text === null || text.trim().length === 0) break;
        const label = `feedback ${sprintId}#${String(iter)}`;
        const id = sessionManager.start<FeedbackCtx>({
          label,
          element: createFeedbackFlow(deps, { sprintId: fields.sprintId as never, cwd: cwd as never }),
          initialCtx: {
            sprintId: fields.sprintId as never,
            cwd: cwd as never,
            feedbackText: text,
            iteration: iter,
          },
          dedupeKey: `feedback:${sprintId}#${String(iter)}`,
        });
        sessionManager.foreground(id);
        // Wait for this iteration's feedback session to settle.
        await new Promise<void>((resolve) => {
          const unsub = sessionManager.subscribe(() => {
            const d = sessionManager.get(id);
            if (!d) {
              unsub();
              resolve();
              return;
            }
            if (d.status === 'completed' || d.status === 'failed' || d.status === 'aborted') {
              unsub();
              resolve();
            }
          });
          // Synthetic check in case the session settled before subscribe.
          const d = sessionManager.get(id);
          if (d && (d.status === 'completed' || d.status === 'failed' || d.status === 'aborted')) {
            unsub();
            resolve();
          }
        });
      }

      // ── Auto-close ──────────────────────────────────────────────────────
      // After the feedback loop drains, check whether the sprint can be
      // closed automatically. Conditions: every task `done`, sprint still
      // `active`. If anything is blocked / in_progress / already closed,
      // skip silently — the user can intervene manually.
      try {
        const tasksAfter = await deps.taskRepo.findBySprintId(fields.sprintId as never);
        if (!tasksAfter.ok) return;
        if (tasksAfter.value.length === 0) return;
        const allDone = tasksAfter.value.every((t) => t.status === 'done');
        if (!allDone) return;
        const sprintAfter = await deps.sprintRepo.findById(fields.sprintId as never);
        if (!sprintAfter.ok) return;
        if (sprintAfter.value.status !== 'active') return;
        const closer = new CloseSprintUseCase(deps.sprintRepo);
        const closed = await closer.execute({ id: fields.sprintId as never, now: IsoTimestamp.now() });
        if (closed.ok) {
          deps.logger.success(`sprint ${fields.sprintId} closed automatically — all tasks done`, {
            sprintId: fields.sprintId,
          });
        }
        // Failures are silent — auto-close is a best-effort convenience.
      } catch {
        // Defensive: any unexpected throw shouldn't surface UI noise.
      }
    })();
  }, [descriptor, sessionManager, runnerStatus]);

  return null;
}
