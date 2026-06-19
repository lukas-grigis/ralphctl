import { join } from 'node:path';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createRefineFlow } from '@src/application/flows/refine/flow.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

export const launchRefine = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, interactiveAi, skillsAdapter, skillSource, bridge, sessionId, effort } = ctx;
  const missing = await checkCli('refine', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // Refine intentionally does not require a repo path — the AI session is rooted at the
  // per-ticket unit folder (`<sprintDir>/refinement/<ticket-slug>/`), not the repo, because
  // refinement is implementation-agnostic.
  const pending = snapshot.sprint.tickets.filter((t) => t.status === 'pending');
  // Subpath of the canonical `<id>--<slug>/` sprint dir, direct-built from the sprint entity.
  const refinementRoot = AbsolutePath.parse(
    join(buildSprintDir(deps.storage.dataRoot, snapshot.sprint.id, snapshot.sprint.slug), 'refinement')
  );
  if (!refinementRoot.ok) return { ok: false, reason: refinementRoot.error.message };
  // The refine flow only ever posts the refined requirements as a comment on the ticket's
  // existing linked issue — it never opens a new issue and never overwrites a description. The
  // out-of-box default for the comment action is opt-in via `settings.scm.postRefinementComment`.
  const postRefinementComment = settings.scm.postRefinementComment;
  // HITL approval — runs AFTER the AI proposes refined requirements and BEFORE the ticket
  // transitions. `runInTerminal` resolves before we get here, so Ink has remounted and
  // `<PromptHost>` is subscribed by the time we enqueue the choice. Cancel = reject.
  //
  // The reviewer picks from up to four options. Two terminate the loop, two iterate:
  //   - Approve         → terminal; persist the current body locally.
  //   - Edit            → askTextArea on the current body, then re-show this prompt with the
  //                       edit applied. Cancelling the textarea keeps the previous body and
  //                       returns to the prompt — never loses the reviewer's place.
  //   - Post as comment → terminal; persist locally AND tell the leaf to post the body as a
  //                       comment on the linked issue. Shown only when the ticket has a `link`;
  //                       a ticket with no linked issue has nothing to comment on.
  //   - Reject          → terminal; ticket stays pending.
  //
  // The default selection follows `settings.scm.postRefinementComment`: when enabled and the
  // ticket has a link, "Post as comment" is listed first (the renderer highlights the first
  // entry); otherwise "Approve" leads, so commenting is an explicit opt-in.
  //
  // `body` is returned on accept so the use case persists the (possibly edited) text rather
  // than re-using the AI's original proposal.
  type Decision = 'approve' | 'edit' | 'post_comment' | 'reject';
  const reviewBeforeApprove = async (
    proposed: string,
    ticket: { readonly title: string; readonly link?: unknown }
  ): Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean; readonly body?: string }> => {
    const hasLink = ticket.link !== undefined;
    const approveOption = {
      label: 'Approve',
      value: 'approve' as Decision,
      description: 'Save the refined requirements locally.',
    };
    const commentOption = {
      label: 'Post as comment',
      value: 'post_comment' as Decision,
      description: 'Save locally AND post the body as a comment on the linked issue.',
    };
    // Lead with whichever option is the configured default so the renderer highlights it first.
    const leadOptions = hasLink && postRefinementComment ? [commentOption, approveOption] : [approveOption];
    const options: Array<{ label: string; value: Decision; description?: string }> = [
      ...leadOptions,
      { label: 'Edit', value: 'edit', description: 'Open the body in an editor; come back here to decide.' },
      ...(hasLink && !postRefinementComment ? [commentOption] : []),
      { label: 'Reject', value: 'reject', description: 'Leave the ticket pending — no changes.' },
    ];

    let body = proposed;
    while (true) {
      const message = `Approve refined requirements for "${ticket.title}"?\n\n${body.trim()}`;
      const answered = await deps.interactive.askChoice<Decision>(message, options);
      if (!answered.ok) return { accept: false };
      switch (answered.value) {
        case 'approve':
          return { accept: true, alsoUpdateOrigin: false, body };
        case 'post_comment':
          return { accept: true, alsoUpdateOrigin: true, body };
        case 'reject':
          return { accept: false };
        case 'edit': {
          const edited = await deps.interactive.askTextArea(`Edit refined requirements for "${ticket.title}"`, {
            initial: body,
          });
          // Cancel keeps the prior body so the reviewer never loses their place; only a non-
          // empty submission replaces it.
          if (edited.ok && edited.value.trim().length > 0) body = edited.value;
          continue;
        }
      }
    }
  };
  const element: Element<RefineCtx> = createRefineFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      interactiveAi,
      templateLoader: deps.app.templateLoader,
      writeFile: deps.app.writeFile,
      runInTerminal: deps.runInTerminal,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      skillsAdapter,
      skillSource,
      reviewBeforeApprove,
      postRefinementComment,
      ...(deps.app.issueFetcher !== undefined ? { issueFetcher: deps.app.issueFetcher } : {}),
      ...(deps.app.issuePusher !== undefined ? { issuePusher: deps.app.issuePusher } : {}),
    },
    {
      sprintId: snapshot.sprint.id,
      pendingTickets: pending,
      providerId: settings.ai.refine.provider,
      model: settings.ai.refine.model,
      ...(effort !== undefined ? { effort } : {}),
      refinementRoot: refinementRoot.value,
    }
  );
  const runner = createRunner<RefineCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  return { ok: true, runner: bridge(runner) as Runner<unknown>, title: `Refine — ${snapshot.sprint.name}` };
};
