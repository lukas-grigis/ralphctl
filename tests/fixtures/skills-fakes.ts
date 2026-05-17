/**
 * Tiny fakes for the skills ports — used by flow tests that construct flow deps directly and
 * don't care about the skills mechanism (they just need install/uninstall to succeed).
 *
 * Real adapter behaviour (Claude file writes, project-wins) is covered by the dedicated
 * integration tests under `tests/integration/ai/skills/`.
 */

import { Result } from '@src/domain/result.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';

export const noopSkillsAdapter: SkillsAdapter = {
  install: async () => Result.ok(undefined),
  uninstall: async () => Result.ok(undefined),
  describeSkillsConvention: () => 'Test provider has no skills convention; proceed directly to authoring.',
};

export const emptySkillSource: SkillSource = {
  getForFlow: async () => Result.ok([]),
};
