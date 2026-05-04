/**
 * `buildRefinementUnitLeaf` — materialise the per-ticket refinement unit
 * folder under `<sprintDir>/refinement/<unit-slug>/` and stamp the
 * resulting paths onto the chain context.
 *
 * The refinement unit IS the AI session's cwd — the AI runs inside the
 * unit folder, reads `./ticket.md`, and writes its raw output to
 * `./requirements.json`. Project skills always win against bundled
 * defaults (the `link-skills` leaf handles the overlay).
 *
 * Position in the chain: AFTER the per-ticket stage leaf (which sets
 * `ctx.currentTicket`) and BEFORE `link-skills`.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { SessionFolderBuilderPort } from '@src/business/ports/session-folder-builder-port.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

export interface BuildRefinementUnitCtx {
  readonly sprint?: Sprint;
  readonly currentTicket?: Ticket;
  readonly cwd?: AbsolutePath;
  readonly refinementUnitRoot?: AbsolutePath;
  readonly refinementSessionMdPath?: AbsolutePath;
  readonly refinementTicketMdPath?: AbsolutePath;
  readonly refinementRequirementsJsonPath?: AbsolutePath;
}

export interface BuildRefinementUnitLeafDeps {
  readonly sessionFolderBuilder: SessionFolderBuilderPort;
  readonly aiSession: AiSessionPort;
}

export interface BuildRefinementUnitLeafOptions {
  readonly name?: string;
}

export function buildRefinementUnitLeaf<TCtx extends BuildRefinementUnitCtx>(
  deps: BuildRefinementUnitLeafDeps,
  opts: BuildRefinementUnitLeafOptions = {}
): Element<TCtx> {
  const name = opts.name ?? 'build-refinement-unit';
  return new Leaf<
    TCtx,
    { readonly sprint: Sprint; readonly ticket: Ticket },
    {
      readonly root: AbsolutePath;
      readonly sessionMdPath: AbsolutePath;
      readonly ticketMdPath: AbsolutePath;
      readonly requirementsJsonPath: AbsolutePath;
    }
  >(name, {
    useCase: {
      async execute(input): Promise<
        Result<
          {
            readonly root: AbsolutePath;
            readonly sessionMdPath: AbsolutePath;
            readonly ticketMdPath: AbsolutePath;
            readonly requirementsJsonPath: AbsolutePath;
          },
          DomainError
        >
      > {
        await deps.aiSession.ensureReady();
        const aiProvider = deps.aiSession.getProviderName();
        const built = await deps.sessionFolderBuilder.buildRefinementUnit({
          sprint: input.sprint,
          ticket: input.ticket,
          aiProvider,
        });
        if (!built.ok) return Result.error(built.error);
        return Result.ok(built.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`${name}: ctx.sprint must be loaded before this leaf`);
      }
      if (!ctx.currentTicket) {
        throw new Error(`${name}: ctx.currentTicket must be set by stage-ticket before this leaf`);
      }
      return { sprint: ctx.sprint, ticket: ctx.currentTicket };
    },
    output: (ctx, out) => ({
      ...ctx,
      cwd: out.root,
      refinementUnitRoot: out.root,
      refinementSessionMdPath: out.sessionMdPath,
      refinementTicketMdPath: out.ticketMdPath,
      refinementRequirementsJsonPath: out.requirementsJsonPath,
    }),
  });
}
