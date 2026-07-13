/**
 * `installAgentDefinitionsLeaf` — install a role's bound agent definition into the AI session's
 * sandbox before the session runs.
 *
 * Pairs with {@link uninstallAgentDefinitionsLeaf}. Unlike `installSkillsLeaf` (flow-scoped,
 * resolved at execute time via a `SkillSource`), a role's binding is resolved ONCE at launch —
 * there is at most one bound definition per role — so the leaf takes the already-resolved
 * `AgentDefinition` directly rather than looking it up itself.
 *
 * A `definition: undefined` (the role has no binding, or the bound name didn't resolve) is a
 * no-op: no file is written, so an unbound role's session is left exactly as it was before this
 * leaf existed.
 */

import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

export interface InstallAgentDefinitionsDeps {
  readonly agentDefinitionAdapter: AgentDefinitionAdapter;
}

export interface InstallAgentDefinitionsOptions<TCtx> {
  readonly name?: string;
  /** The role's resolved binding, or `undefined` when the role has no binding. */
  readonly definition: AgentDefinition | undefined;
  /** Project the chain context to the AI session's cwd. Throws if the upstream leaves haven't
   * populated it yet — surfaces a misconfigured chain at the failing leaf rather than later. */
  readonly cwdPicker: (ctx: TCtx) => AbsolutePath;
}

export const installAgentDefinitionsLeaf = <TCtx>(
  deps: InstallAgentDefinitionsDeps,
  opts: InstallAgentDefinitionsOptions<TCtx>
): Element<TCtx> => {
  const name = opts.name ?? 'install-agent-definitions';
  return leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, DomainError>> {
        if (opts.definition === undefined) return Result.ok(undefined);
        return deps.agentDefinitionAdapter.install(input.cwd, [opts.definition]);
      },
    },
    input: (ctx) => ({ cwd: opts.cwdPicker(ctx) }),
    output: (ctx) => ctx,
  });
};
