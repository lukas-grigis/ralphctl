/** Resolve the implement flow's per-role opt-in agent-definition bindings. */

import { type AiImplementRole, type AiImplementSettings, primaryAgentBinding } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { createAgentDefinitionAdapter } from '@src/integration/ai/agents/adapter-factory.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';

/**
 * Resolve one implement role's agent-definition binding into the concrete {@link AgentDefinition}, or `undefined`
 * when the role has no binding at all.
 * @public
 */
export const resolveRoleAgentBinding = async (
  source: AgentDefinitionSource,
  bindingName: string | undefined,
  role: AiImplementRole,
  logger: Logger
): Promise<AgentDefinition | undefined> => {
  if (bindingName === undefined) return undefined;
  const result = await source.getByName(bindingName);
  const log = logger.named('implement.agents');
  if (!result.ok) {
    log.warn(`agent-definition binding lookup failed for the ${role} role — continuing under base behaviour`, {
      role,
      name: bindingName,
      error: result.error.message,
    });
    return undefined;
  }
  if (result.value === undefined) {
    log.warn(
      `agent-definition binding '${bindingName}' not found for the ${role} role — continuing under base behaviour`,
      { role, name: bindingName }
    );
    return undefined;
  }
  return result.value;
};

/**
 * Build the per-role "## Agent Definition" prompt section for a resolved binding.
 * @public
 */
export const buildAgentDefinitionSection = (definition: AgentDefinition, adapter: AgentDefinitionAdapter): string =>
  [
    `A bound sub-agent persona is installed for this session: \`${definition.name}\` — ${definition.description}`,
    adapter.describeConvention(),
    'Read it and let its instructions guide your approach for this session, in addition to the role above.',
  ].join(' ');

/** One resolved role's agent-definition binding — both fields absent when the role is unbound. */
export interface RoleAgentBinding {
  readonly definition?: AgentDefinition;
  readonly section?: string;
}

/**
 * Resolve both implement roles' agent-definition bindings against the composed bundled+operator source, and build a
 * role-scoped {@link AgentDefinitionAdapter} for each.
 * @public
 */
export const resolveImplementAgentBindings = async (
  deps: LauncherDeps,
  implementPair: AiImplementSettings
): Promise<{
  readonly generatorAdapter: AgentDefinitionAdapter;
  readonly evaluatorAdapter: AgentDefinitionAdapter;
  readonly generator: RoleAgentBinding;
  readonly evaluator: RoleAgentBinding;
}> => {
  const generatorAdapter = createAgentDefinitionAdapter({
    provider: implementPair.generator.provider,
    logger: deps.app.logger,
  });
  const evaluatorAdapter = createAgentDefinitionAdapter({
    provider: implementPair.evaluator.provider,
    logger: deps.app.logger,
  });
  const resolveRole = async (role: AiImplementRole, adapter: AgentDefinitionAdapter): Promise<RoleAgentBinding> => {
    const bindingName = primaryAgentBinding(implementPair.agents, role);
    const definition = await resolveRoleAgentBinding(
      deps.app.agentDefinitionSource,
      bindingName,
      role,
      deps.app.logger
    );
    if (definition === undefined) return {};
    return { definition, section: buildAgentDefinitionSection(definition, adapter) };
  };
  const [generator, evaluator] = await Promise.all([
    resolveRole('generator', generatorAdapter),
    resolveRole('evaluator', evaluatorAdapter),
  ]);
  return { generatorAdapter, evaluatorAdapter, generator, evaluator };
};
