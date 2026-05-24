import { join } from 'node:path';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createRefineFlow } from '@src/application/flows/refine/flow.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { parseGitRemoteUrl } from '@src/integration/scm/issue-fetcher.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

/**
 * Best-effort `git remote get-url origin` → {@link IssueOriginRef}. Returns `undefined` on every
 * failure mode (no path, no repo, no `origin`, malformed URL, parser miss). The refine flow's
 * "create origin" option simply hides itself when this returns undefined — silent failure here
 * is the right shape; the user sees the 2-option prompt instead of the 3-option one.
 */
const deriveOriginFromGit = async (
  cwd: AbsolutePath | undefined,
  gitRunner: GitRunner
): Promise<IssueOriginRef | undefined> => {
  if (cwd === undefined) return undefined;
  const result = await gitRunner.run(cwd, ['remote', 'get-url', 'origin']);
  if (!result.ok) return undefined;
  if (result.value.exitCode !== 0) return undefined;
  const url = result.value.stdout.trim();
  if (url.length === 0) return undefined;
  const parsed = parseGitRemoteUrl(url);
  return parsed === null ? undefined : parsed;
};

export const launchRefine = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, extras, settings, interactiveAi, skillsAdapter, skillSource, bridge, sessionId, effort } =
    ctx;
  const missing = await checkCli('refine', settings);
  if (missing !== undefined) return missing;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  // Refine intentionally does not require a repo path — the AI session is rooted at the
  // per-ticket unit folder (`<sprintDir>/refinement/<ticket-slug>/`), not the repo, because
  // refinement is implementation-agnostic. The repo path is still consulted below to derive
  // `defaultIssueOrigin` for the "update remote" reviewer option, but that resolution is
  // best-effort and tolerates a missing path.
  const pending = snapshot.sprint.tickets.filter((t) => t.status === 'pending');
  const refinementRoot = AbsolutePath.parse(
    join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id), 'refinement')
  );
  if (!refinementRoot.ok) return { ok: false, reason: refinementRoot.error.message };
  // Origin resolution order:
  //   1. Explicit `project.defaultIssueOrigin` (operator override).
  //   2. Auto-derived from the first repo's `git remote get-url origin`.
  //   3. Undefined → the refine flow's "create origin" option is hidden.
  // The auto-derivation is best-effort: a missing remote / non-recognised URL / failed git
  // command all collapse to "no derived origin" without surfacing an error to the user.
  let defaultIssueOrigin = snapshot.project?.defaultIssueOrigin;
  if (defaultIssueOrigin === undefined && snapshot.project !== undefined) {
    defaultIssueOrigin = await deriveOriginFromGit(snapshot.project.repositories[0]?.path, deps.app.gitRunner);
  }
  // HITL approval — runs AFTER the AI proposes refined requirements and BEFORE the ticket
  // transitions. `runInTerminal` resolves before we get here, so Ink has remounted and
  // `<PromptHost>` is subscribed by the time we enqueue the choice. Cancel = reject.
  //
  // The reviewer picks from up to four options. Two terminate the loop, two iterate:
  //   - Approve         → terminal; persist the current body locally.
  //   - Edit            → askTextArea on the current body, then re-show this prompt with the
  //                       edit applied. Cancelling the textarea keeps the previous body and
  //                       returns to the prompt — never loses the reviewer's place.
  //   - Update remote   → terminal; persist locally AND tell the leaf to push to the source
  //                       issue (label adapts: "Update remote (owner/repo)" when creating a new
  //                       issue, "Update remote" when replacing an existing one). The option is
  //                       hidden entirely when no origin is resolvable.
  //   - Reject          → terminal; ticket stays pending.
  //
  // `body` is returned on accept so the use case persists the (possibly edited) text rather
  // than re-using the AI's original proposal.
  type Decision = 'approve' | 'edit' | 'update_remote' | 'reject';
  const reviewBeforeApprove = async (
    proposed: string,
    ticket: { readonly title: string; readonly link?: unknown }
  ): Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean; readonly body?: string }> => {
    const hasLink = ticket.link !== undefined;
    const remoteLabel = hasLink
      ? 'Update remote'
      : defaultIssueOrigin !== undefined
        ? `Update remote (${defaultIssueOrigin.owner}/${defaultIssueOrigin.repo})`
        : undefined;
    const remoteDescription = hasLink
      ? 'Save locally AND replace the body of the source issue.'
      : 'Save locally AND open a new issue with this body on the configured repo.';
    const options: Array<{ label: string; value: Decision; description?: string }> = [
      { label: 'Approve', value: 'approve', description: 'Save the refined requirements locally.' },
      { label: 'Edit', value: 'edit', description: 'Open the body in an editor; come back here to decide.' },
      ...(remoteLabel
        ? [{ label: remoteLabel, value: 'update_remote' as Decision, description: remoteDescription }]
        : []),
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
        case 'update_remote':
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
      skillsAdapter,
      skillSource,
      reviewBeforeApprove,
      ...(deps.app.issueFetcher !== undefined ? { issueFetcher: deps.app.issueFetcher } : {}),
      ...(deps.app.issuePusher !== undefined ? { issuePusher: deps.app.issuePusher } : {}),
      ...(defaultIssueOrigin !== undefined ? { defaultIssueOrigin } : {}),
    },
    {
      sprintId: snapshot.sprint.id,
      pendingTickets: pending,
      model: extras.modelOverride ?? settings.ai.refine.model,
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
