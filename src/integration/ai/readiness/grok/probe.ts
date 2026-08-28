import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { GrokArtifacts } from '@src/integration/ai/readiness/grok/artifacts.ts';
import { probeFile, probeNamedDirCollection } from '@src/integration/ai/readiness/_engine/probe-fs.ts';
import { absentState, presentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import { hasAnyGrokArtifact } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';

/**
 * Filesystem probe for Grok artifacts. Looks under `repository.path` for:
 *   - `AGENTS.md` (project context memory, shared cross-tool convention)
 *   - `.grok/skills/<name>/SKILL.md` (named project skills)
 *
 * Returns `present` iff at least one artifact was discovered. Read errors are surfaced as
 * {@link ProbeError}; absent paths are normal.
 */
export const grokProbe: ReadinessProbe<GrokArtifacts> = {
  tool: 'grok',
  async evaluate(repository: Repository, now: IsoTimestamp): Promise<Result<ReadinessState, ProbeError>> {
    const root = repository.path;

    const agentsMd = await probeFile(join(root, 'AGENTS.md'));
    if (!agentsMd.ok) return Result.error(agentsMd.error);

    const skills = await probeNamedDirCollection(join(root, '.grok/skills'), 'SKILL.md');
    if (!skills.ok) return Result.error(skills.error);

    const artifacts: GrokArtifacts = {
      tool: 'grok',
      ...(agentsMd.value !== undefined ? { agentsMd: agentsMd.value } : {}),
      skills: skills.value,
    };
    return Result.ok(hasAnyGrokArtifact(artifacts) ? presentState(now, artifacts) : absentState(now));
  },
};
