/**
 * Tiny fakes for the agent-definition ports — used by flow tests that construct flow deps
 * directly and don't care about the agent-definition mechanism (they just need install/uninstall
 * to succeed as no-ops). Mirrors `tests/fixtures/skills-fakes.ts`.
 *
 * Real adapter behaviour (native file rendering per provider) is covered by the dedicated
 * integration tests under `tests/integration/ai/agents/`.
 */

import { Result } from '@src/domain/result.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';

export const noopAgentDefinitionAdapter: AgentDefinitionAdapter = {
  install: async () => Result.ok(undefined),
  uninstall: async () => Result.ok(undefined),
  describeConvention: () => 'Test provider has no agent-definition convention; proceed directly to authoring.',
};

export const emptyAgentDefinitionSource: AgentDefinitionSource = {
  list: async () => Result.ok([]),
  getByName: async () => Result.ok(undefined),
};
