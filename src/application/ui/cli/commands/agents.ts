import type { Command } from 'commander';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createBundledAgentDefinitionSource } from '@src/integration/ai/agents/bundled/source.ts';
import { createOperatorAgentDefinitionSource } from '@src/integration/ai/agents/operator/source.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import type { AiImplementRole } from '@src/domain/entity/settings.ts';

const IMPLEMENT_ROLES: readonly AiImplementRole[] = ['generator', 'evaluator'];

interface ListedDefinition {
  readonly tier: 'bundled' | 'operator';
  readonly definition: AgentDefinition;
}

/**
 * Register the `agents` command group.
 *
 *   ralphctl agents list
 *
 * Operator-facing catalog of the portable agent definitions available to bind to the implement
 * generator/evaluator role — the bundled vetted set plus any operator drop-ins under
 * `<appRoot>/agents`. Project-authored definitions have no enumerable source (they already live
 * where the provider's CLI looks for them — see `composeAgentDefinitionSources`'s doc comment),
 * so they don't appear here; a project definition still wins a name collision at launch. A
 * dedicated TUI catalog view is deferred — this CLI listing is the only inspection surface for
 * now, mirroring how `runs list` / `project list` serve as the CLI-only view for their domains.
 */
export const registerAgentsCommand = (program: Command): void => {
  const agents = program.command('agents').description('inspect portable agent definitions');

  agents
    .command('list')
    .description('list bundled + operator agent definitions and which implement role each is bound to')
    .action(async () => {
      const { deps, storage } = await bootstrapCli();

      const bundledSource = createBundledAgentDefinitionSource();
      const operatorSource = createOperatorAgentDefinitionSource({
        operatorAgentDefinitionsRoot: storage.operatorAgentDefinitionsRoot,
        logger: deps.logger,
      });

      const [bundled, operator] = await Promise.all([bundledSource.list(), operatorSource.list()]);
      if (!bundled.ok) {
        process.stderr.write(`error: ${bundled.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (!operator.ok) {
        process.stderr.write(`error: ${operator.error.message}\n`);
        process.exitCode = 1;
        return;
      }

      const showFlow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
      const current = await showFlow.execute({ input: undefined });
      if (!current.ok) {
        process.stderr.write(`error: ${current.error.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const agentBindings = current.value.ctx.output!.ai.implement.agents;

      // Later tier wins a name collision, mirroring `composeAgentDefinitionSources` — an
      // operator drop-in shadows a bundled definition of the same name in this listing too.
      const byName = new Map<string, ListedDefinition>();
      for (const definition of bundled.value) byName.set(definition.name, { tier: 'bundled', definition });
      for (const definition of operator.value) byName.set(definition.name, { tier: 'operator', definition });

      if (byName.size === 0) {
        process.stdout.write('(no agent definitions available)\n');
        return;
      }

      const listed = [...byName.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
      for (const { tier, definition } of listed) {
        const boundRoles = IMPLEMENT_ROLES.filter((role) => agentBindings?.[role] === definition.name);
        const boundLabel = boundRoles.length > 0 ? boundRoles.join(', ') : '-';
        process.stdout.write(
          `${definition.name.padEnd(28)}  ${tier.padEnd(8)}  bound: ${boundLabel.padEnd(20)}  ${definition.description}\n`
        );
      }
    });
};
