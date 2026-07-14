/**
 * Resolve the implement flow's per-role opt-in agent-definition bindings. Split out of
 * `launch/implement.ts` (which composes these results into the deps/opts bags) so that file
 * stays under the line-count ratchet — these are pure/async composition helpers with no
 * dependency on the rest of the launcher's control flow.
 */

import { type AiImplementRole, type AiImplementSettings, primaryAgentBinding } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { createAgentDefinitionAdapter } from '@src/integration/ai/agents/adapter-factory.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';

/**
 * Resolve one implement role's agent-definition binding into the concrete {@link AgentDefinition},
 * or `undefined` when the role has no binding at all. A bound name that does NOT resolve against
 * the composed bundled+operator source (a typo, or a definition the operator removed) is reported
 * as a logged warning rather than a launch failure — the role's session then runs unaided, exactly
 * as if no binding had been configured (the resilience posture the skills subsystem already uses
 * for its own opt-in seams).
 *
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
 * Build the per-role "## Agent Definition" prompt section for a resolved binding. Every current
 * provider adapter (Claude / Copilot / Codex) is filesystem-native — the launcher has already
 * installed the definition's native file by the time the generator/evaluator prompt is built —
 * so the section ANNOUNCES that file via the adapter's `describeConvention()` rather than
 * injecting the raw body. A future provider with no native discovery format would inject
 * `definition.content` directly instead; the seam here is generic enough to add that branch
 * without touching call sites.
 *
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
 * Resolve both implement roles' agent-definition bindings against the composed bundled+operator
 * source, and build a role-scoped {@link AgentDefinitionAdapter} for each — generator and
 * evaluator may target different providers, so each gets its own adapter unconditionally (mirrors
 * `buildImplementProviders`'s per-role provider construction). A role's `definition`/`section`
 * stay absent when it has no binding, so downstream composition (install leaves, prompt sections,
 * model/effort override) is a byte-for-byte no-op for that role.
 *
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
