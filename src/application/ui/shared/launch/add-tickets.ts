import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createAddTicketsFlow } from '@src/application/flows/add-tickets/flow.ts';
import type { AddTicketsCtx } from '@src/application/flows/add-tickets/ctx.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchAddTickets = (ctx: LaunchContext): LaunchResult => {
  const { deps, snapshot, bridge, sessionId } = ctx;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  const element: Element<AddTicketsCtx> = createAddTicketsFlow({
    sprintRepo: deps.app.sprintRepo,
    interactive: deps.interactive,
    clock: deps.app.clock,
    eventBus: deps.app.eventBus,
    logger: deps.app.logger,
    ...(deps.app.issueFetcher !== undefined ? { issueFetcher: deps.app.issueFetcher } : {}),
  });
  const runner = createRunner<AddTicketsCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Add tickets — ${snapshot.sprint.name}`,
  };
};
