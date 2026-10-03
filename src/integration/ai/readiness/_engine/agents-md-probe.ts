import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import type { AgentsMdArtifacts } from '@src/integration/ai/readiness/_engine/tool-artifacts.ts';
import { probeFile, probeNamedDirCollection } from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyAgentsMdArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';
import { providerForTool } from '@src/integration/ai/readiness/_engine/tool.ts';

/**
 * Filesystem probe for an `AGENTS.md`-convention tool. Looks under `repository.path` for:
 *   - `AGENTS.md` (project context memory, shared cross-tool convention)
 *   - `<skillsParentDir>/skills/<name>/SKILL.md` — the same dir the skills adapter installs into
 *
 * Returns `present` iff at least one artifact was discovered. Read errors are surfaced as
 * {@link ProbeError}; absent paths are normal.
 */
export const createAgentsMdProbe = <T extends AgentsMdArtifacts>(tool: T['tool']): ReadinessProbe<T> => ({
  tool,
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const root = repository.path;

    const agentsMd = await probeFile(join(root, 'AGENTS.md'));
    if (!agentsMd.ok) return Result.error(agentsMd.error);

    const skillsDir = join(root, PROVIDER_TRAITS[providerForTool(tool)].skillsParentDir, 'skills');
    const skills = await probeNamedDirCollection(skillsDir, 'SKILL.md');
    if (!skills.ok) return Result.error(skills.error);

    const artifacts: AgentsMdArtifacts = {
      tool,
      ...(agentsMd.value !== undefined ? { agentsMd: agentsMd.value } : {}),
      skills: skills.value,
    };
    return Result.ok(hasAnyAgentsMdArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
});
