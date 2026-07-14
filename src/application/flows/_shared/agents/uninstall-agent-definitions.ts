/**
 * `uninstallAgentDefinitionsLeaf` — uninstall the agent definition the matching
 * {@link installAgentDefinitionsLeaf} placed into the sandbox.
 *
 * Idempotent: dispatching to an adapter that never saw an install (unbound role, or a role whose
 * bound name never resolved) is a no-op — mirrors `uninstallSkillsLeaf`.
 */

import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';

export interface UninstallAgentDefinitionsDeps {
  readonly agentDefinitionAdapter: AgentDefinitionAdapter;
}

export interface UninstallAgentDefinitionsOptions<TCtx> {
  readonly name?: string;
  /** Same picker as the matching `installAgentDefinitionsLeaf` — ensures install/uninstall
   * target the same sandbox even when the chain has multiple AI sub-sessions per run. */
  readonly cwdPicker: (ctx: TCtx) => AbsolutePath;
}

export const uninstallAgentDefinitionsLeaf = <TCtx>(
  deps: UninstallAgentDefinitionsDeps,
  opts: UninstallAgentDefinitionsOptions<TCtx>
): Element<TCtx> => {
  const name = opts.name ?? 'uninstall-agent-definitions';
  return leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      execute: async (input) => deps.agentDefinitionAdapter.uninstall(input.cwd),
    },
    input: (ctx) => ({ cwd: opts.cwdPicker(ctx) }),
    output: (ctx) => ctx,
  });
};
