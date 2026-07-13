/**
 * `AgentDefinitionSource` — produces the {@link AgentDefinition}s a given source tier owns.
 *
 * Mirrors `SkillSource` (`src/integration/ai/skills/_engine/skill-source.ts`) with one
 * difference: agent definitions are not flow-scoped the way skills are, so `list()` replaces
 * `getForFlow(flowId)` — every source in this subsystem returns its full set unconditionally,
 * and the caller (a composed source, or install-time wiring) decides what to install.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

export interface AgentDefinitionSource {
  /** Every agent definition this source provides. An empty list is a valid, non-error result. */
  list(): Promise<Result<readonly AgentDefinition[], StorageError>>;
  /**
   * Resolve a single agent definition by its exact (namespaced) name. Returns `ok(undefined)`
   * when no definition of that name exists in this source — the "unknown name" case is NOT an
   * error. `StorageError` is reserved for a definition that exists but cannot be read or parsed.
   */
  getByName(name: string): Promise<Result<AgentDefinition | undefined, StorageError>>;
}
