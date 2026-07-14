/**
 * `composeAgentDefinitionSources` — compose two or more {@link AgentDefinitionSource}s into one,
 * with project-wins precedence.
 *
 * There are three source tiers, most-general to most-specific:
 *  1. **bundled** — the vetted set shipped with ralphctl (`agents/bundled/`).
 *  2. **operator** — global drop-ins under `<appRoot>/agents`, authored once and reused across
 *     every project (`agents/operator/`).
 *  3. **project** — a definition the project itself authors directly in its native provider
 *     directory (e.g. `.claude/agents/ralphctl-<name>.md` committed to the repo).
 *
 * The project tier is NOT a source composed here — there is no `AgentDefinitionSource` reading
 * project-authored files, because those files already live where the provider's CLI looks for
 * them. Project-wins precedence is realised one layer down, by
 * `createFilesystemAgentDefinitionAdapter`'s install step: it skips writing a rendered
 * definition whenever a file already exists at the destination path, leaving a project-authored
 * copy untouched. This function only has to arbitrate between bundled and operator: later
 * sources win a name collision, so the conventional call is
 * `composeAgentDefinitionSources(bundled, operator)` — an operator definition overrides a
 * bundled one of the same name.
 *
 * Errors from any source short-circuit: a hard failure on one tier is never masked by another
 * tier's empty result.
 */

import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';

export const composeAgentDefinitionSources = (...sources: readonly AgentDefinitionSource[]): AgentDefinitionSource => {
  const listAll = async (): Promise<Result<readonly AgentDefinition[], StorageError>> => {
    const byName = new Map<string, AgentDefinition>();
    for (const source of sources) {
      const r = await source.list();
      if (!r.ok) return Result.error(r.error);
      // Later sources win a name collision — see the module doc comment for the precedence order.
      for (const definition of r.value) byName.set(definition.name, definition);
    }
    return Result.ok([...byName.values()]);
  };

  return {
    list: listAll,
    async getByName(name: string): Promise<Result<AgentDefinition | undefined, StorageError>> {
      const all = await listAll();
      if (!all.ok) return Result.error(all.error);
      return Result.ok(all.value.find((d) => d.name === name));
    },
  };
};
